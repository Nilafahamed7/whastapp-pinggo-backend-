// services/waManager.js
import pkg from "whatsapp-web.js";
const { Client, LocalAuth, MessageAck } = pkg;
import qrcode from "qrcode-terminal";
import sessionModel from "../models/session.js";
import { v4 as uuidv4 } from "uuid";
import { EventEmitter } from "events";
import {
  notifyMessageReceived,
  notifyMessageDelivered,
  notifyMessageAck,
  notifyGroupMemberAdded,
  notifyGroupMemberRemoved,
  notifySessionUpdate,
} from "./webhookManager.js";

EventEmitter.defaultMaxListeners = 100;


const clients = new Map();

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* -----------------------------------------------------
   Start New or Restore Existing Session
   Supports multiple sessions per user
----------------------------------------------------- */
export async function startNewSession(userId, sessionName = '', forceNew = false) {
  try {
    // Clean up old disconnected sessions
    await sessionModel.deleteMany({
      userId,
      status: { $in: ["disconnected", "auth_failed"] },
      updatedAt: { $lt: new Date(Date.now() - 3600000) }
    });

    // Clean up old QR sessions
    await sessionModel.deleteMany({
      userId,
      status: "qr",
      updatedAt: { $lt: new Date(Date.now() - 600000) }
    });

    // Create new session
    const sessionId = `session_${uuidv4()}`;
    
    await sessionModel.create({
      userId,
      sessionId,
      sessionName: sessionName || `Session ${new Date().toLocaleString()}`,
      status: "pending",
      createdAt: new Date(),
      updatedAt: new Date()
    });

    await createClient(userId, sessionId, sessionName);
    return sessionId;
  } catch (error) {
    console.error(`❌ Error creating session:`, error.message);
    throw error;
  }
}

/* -----------------------------------------------------
   Internal: Create WhatsApp Client Instance
----------------------------------------------------- */
async function createClient(userId, sessionId, sessionName = '') {
  try {
    // Check if client already exists and is ready
    if (clients.has(sessionId)) {
      const existingClient = clients.get(sessionId);
      try {
        if (existingClient.info) {
          return existingClient;
        }
      } catch (e) {
        clients.delete(sessionId);
      }
    }
    
    // Get session info from database
    const sessionInfo = await sessionModel.findOne({ sessionId });
    const displayName = sessionInfo?.sessionName || sessionName || sessionId;

    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: sessionId,
        dataPath: "./.wwebjs_auth",
      }),
      puppeteer: {
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--no-first-run",
          "--no-zygote",
          "--single-process",
          "--disable-gpu",
          "--disable-extensions",
          "--disable-features=IsolateOrigins,site-per-process",
          "--disable-software-rasterizer",
          "--disable-background-timer-throttling",
          "--disable-backgrounding-occluded-windows",
          "--disable-renderer-backgrounding",
          "--disable-web-security",
          "--disable-infobars",
          "--window-size=1920,1080",
          "--start-maximized",
          "--disk-cache-size=1",
          "--media-cache-size=1",
          "--aggressive-cache-discard"
        ],
        timeout: 120000, // Increased to 2 minutes for slower Render.com servers
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      },
      webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
      },
    });

    // Store client immediately
    clients.set(sessionId, client);

    // QR Code event
    client.on("qr", async (qr) => {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`📱 QR CODE: "${displayName}"`);
      console.log(`👤 User: ${userId}`);
      console.log(`🆔 ID: ${sessionId}`);
      console.log(`${'='.repeat(60)}`);
      qrcode.generate(qr, { small: true });
      console.log(`${'='.repeat(60)}\n`);

      await sessionModel.findOneAndUpdate(
        { sessionId },
        { userId, qr, status: "qr", updatedAt: new Date() },
        { upsert: true }
      );
    });

    // Authenticated event
    client.on("authenticated", async () => {
      await sessionModel.findOneAndUpdate(
        { sessionId },
        { status: "authenticated", updatedAt: new Date() },
        { upsert: true }
      );
    });

    // Ready event - Client is fully ready to use
    client.on("ready", async () => {
      const phoneNumber = client.info?.wid?.user || 'Unknown';
      console.log(`✅ Connected: "${displayName}" (${userId}) - Phone: +${phoneNumber} - ID: ${sessionId}`);
      await sessionModel.findOneAndUpdate(
        { sessionId },
        { status: "connected", phoneNumber, qr: null, updatedAt: new Date() },
        { upsert: true }
      );
      
      // Notify webhook
      await notifySessionUpdate({
        sessionId,
        status: "connected",
        phoneNumber,
        timestamp: new Date().toISOString(),
      });
    });

    // Auth failure event
    client.on("auth_failure", async (msg) => {
      console.error(`❌ Auth failed: "${displayName}" (${userId})`);
      await sessionModel.findOneAndUpdate(
        { sessionId },
        { status: "auth_failed", updatedAt: new Date() }
      );
      clients.delete(sessionId);
      
      // Notify webhook
      await notifySessionUpdate({
        sessionId,
        status: "auth_failed",
        phoneNumber: null,
        timestamp: new Date().toISOString(),
      });
    });

    // Disconnected event
    client.on("disconnected", async (reason) => {
      console.log(`⚠️ Disconnected: "${displayName}" (${userId})`);
      await sessionModel.findOneAndUpdate(
        { sessionId },
        { status: "disconnected", updatedAt: new Date() }
      );
      clients.delete(sessionId);
      
      // Notify webhook
      await notifySessionUpdate({
        sessionId,
        status: "disconnected",
        phoneNumber: null,
        timestamp: new Date().toISOString(),
      });
    });

    // Message received event
    client.on("message", async (message) => {
      await notifyMessageReceived({
        messageId: message.id._serialized,
        from: message.from,
        to: message.to || sessionId,
        text: message.body,
        type: message.type,
        hasMedia: message.hasMedia,
        timestamp: message.timestamp,
        sessionId,
      });
    });

    // Message acknowledgment event (sent, delivered, read)
    client.on("message_ack", async (message, ack) => {
      const ackNames = {
        [MessageAck.ACK_ERROR]: "error",
        [MessageAck.ACK_PENDING]: "pending",
        [MessageAck.ACK_SERVER]: "sent",
        [MessageAck.ACK_DEVICE]: "delivered",
        [MessageAck.ACK_READ]: "read",
        [MessageAck.ACK_PLAYED]: "played",
      };
      
      const ackName = ackNames[ack] || "unknown";
      
      if (ack === MessageAck.ACK_DEVICE) {
        await notifyMessageDelivered({
          messageId: message.id._serialized,
          status: "delivered",
          timestamp: new Date().toISOString(),
          sessionId,
        });
      }
      
      // Send detailed ack info
      await notifyMessageAck({
        messageId: message.id._serialized,
        ack,
        ackName,
        timestamp: new Date().toISOString(),
        sessionId,
      });
    });

    // Group participant added event
    client.on("group_join", async (notification) => {
      await notifyGroupMemberAdded({
        groupId: notification.chatId,
        groupName: notification.chatName || null,
        waId: notification.recipientIds?.[0] || notification.id.participant,
        addedBy: notification.author,
        timestamp: new Date().toISOString(),
        sessionId,
      });
    });

    // Group participant removed event
    client.on("group_leave", async (notification) => {
      await notifyGroupMemberRemoved({
        groupId: notification.chatId,
        groupName: notification.chatName || null,
        waId: notification.recipientIds?.[0] || notification.id.participant,
        removedBy: notification.author,
        timestamp: new Date().toISOString(),
        sessionId,
      });
    });

    // Initialize with timeout and retry logic
    const initPromise = client.initialize();
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Initialization timeout after 60s")), 60000)
    );

    try {
      await Promise.race([initPromise, timeoutPromise]);
      return client;
    } catch (initError) {
      // Check if it's a network error
      if (initError.message.includes('ERR_INTERNET_DISCONNECTED') || 
          initError.message.includes('ERR_NAME_NOT_RESOLVED') ||
          initError.message.includes('net::')) {
        console.error(`🌐 Network error for ${sessionId}: ${initError.message}`);
        console.log(`💡 Tip: Check your internet connection and try again`);
        
        await sessionModel.findOneAndUpdate(
          { sessionId },
          { status: "network_error", updatedAt: new Date() }
        );
      } else {
        await sessionModel.findOneAndUpdate(
          { sessionId },
          { status: "failed", updatedAt: new Date() }
        );
      }
      
      clients.delete(sessionId);
      throw initError;
    }
  } catch (error) {
    console.error(`❌ Failed to create client ${sessionId}:`, error.message);
    clients.delete(sessionId);
    throw error;
  }
}

/* -----------------------------------------------------
   Disconnect / Destroy Session
----------------------------------------------------- */
export async function disconnectSession(sessionId) {
  const client = clients.get(sessionId);
  if (client) {
    try {
      await client.destroy();
      clients.delete(sessionId);
    } catch (err) {
      console.error(`❌ Error destroying session ${sessionId}:`, err.message);
    }
  }

  await sessionModel.findOneAndUpdate(
    { sessionId },
    { status: "disconnected", updatedAt: new Date() }
  );
}

/* -----------------------------------------------------
   Delete session permanently (from memory + DB)
------------------------------------------------------ */
export async function deleteSession(sessionId) {
  console.log(`🗑️ Starting deletion process for session: ${sessionId}`);
  
  // Step 1: Destroy WhatsApp client in memory
  const client = clients.get(sessionId);
  if (client) {
    try {
      await client.destroy();
      clients.delete(sessionId);
      console.log(`✅ Destroyed WhatsApp client for session: ${sessionId}`);
    } catch (err) {
      console.error(`❌ Error destroying client ${sessionId}:`, err.message);
    }
  } else {
    console.log(`⚠️ No active client found in memory for: ${sessionId}`);
  }

  // Step 2: Delete from MongoDB Atlas/Local database
  const result = await sessionModel.findOneAndDelete({ sessionId });
  if (result) {
    console.log(`✅ Deleted session from MongoDB database: ${sessionId}`);
  } else {
    console.log(`⚠️ Session not found in MongoDB: ${sessionId}`);
  }

  // Step 3: Delete local authentication folder (.wwebjs_auth)
  try {
    const fs = await import('fs');
    const path = await import('path');
    const authPath = path.join(process.cwd(), '.wwebjs_auth', `session-${sessionId}`);
    
    if (fs.existsSync(authPath)) {
      // Remove directory recursively
      fs.rmSync(authPath, { recursive: true, force: true });
      console.log(`✅ Deleted local auth folder: ${authPath}`);
    } else {
      console.log(`⚠️ Local auth folder not found: ${authPath}`);
    }
  } catch (err) {
    console.error(`❌ Error deleting local auth folder for ${sessionId}:`, err.message);
  }

  console.log(`✅ Session deletion complete: ${sessionId}`);
  return result;
}

/* -----------------------------------------------------
   Get sessions from DB by user
----------------------------------------------------- */
export async function getUserSessions(userId) {
  return await sessionModel.find({ userId }).sort({ updatedAt: -1 });
}

/* -----------------------------------------------------
   Clear all sessions (destroys clients + clears DB)
----------------------------------------------------- */
export async function clearAllSessions() {
  // Destroy all clients
  for (const [id, client] of clients.entries()) {
    try {
      await client.destroy();
    } catch (e) {
      // ignore
    }
    clients.delete(id);
  }

  // Delete from database
  const result = await sessionModel.deleteMany({});
  
  // Delete .wwebjs_auth folder
  try {
    const fs = await import('fs');
    const path = await import('path');
    const authPath = path.join(process.cwd(), '.wwebjs_auth');
    
    if (fs.existsSync(authPath)) {
      fs.rmSync(authPath, { recursive: true, force: true });
    }
  } catch (fsError) {
    console.error("Error deleting auth folder:", fsError.message);
  }
  
  return { cleared: result.deletedCount };
}

/* -----------------------------------------------------
   Get a Client instance (throws when missing)
   - Returns whatsapp-web.js Client instance
----------------------------------------------------- */
export function getClient(sessionId) {
  const client = clients.get(sessionId);
  if (!client) throw new Error(`No active client for session: ${sessionId}`);
  return client;
}

/* Alias for backward compatibility */
export const getActiveClient = getClient;

/* -----------------------------------------------------
   Restore a specific session by sessionId
   - Used when session exists in DB but not in memory
----------------------------------------------------- */
export async function restoreSession(sessionId) {
  try {
    // Clean up sessionId (remove extra spaces)
    sessionId = sessionId.trim();
    
    // Check if already in memory
    if (clients.has(sessionId)) {
      const client = clients.get(sessionId);
      try {
        if (client.info) {
          console.log(`♻️ Session ${sessionId} already active`);
          return client;
        }
      } catch (e) {
        // Client exists but not ready, will reinitialize below
        clients.delete(sessionId);
      }
    }

    // Get session from database - check ANY status, not just connected
    const session = await sessionModel.findOne({ sessionId });

    if (!session) {
      throw new Error(`Session ${sessionId} not found in database`);
    }

    console.log(`♻️ Restoring: "${session.sessionName || sessionId}" (${session.userId})`);
    
    // Create/restore the client
    await createClient(session.userId, sessionId, session.sessionName);
    
    // Wait for client to initialize (up to 30 seconds)
    let attempts = 0;
    const maxAttempts = 30;
    
    while (attempts < maxAttempts) {
      await delay(1000);
      const client = clients.get(sessionId);
      
      if (client) {
        try {
          if (client.info) {
            return client;
          }
        } catch (e) {
          // Client not ready yet
        }
      }
      
      attempts++;
    }
    
    // Client didn't become ready in time but might still be initializing
    const client = clients.get(sessionId);
    if (client) {
      return client;
    }
    
    throw new Error(`Failed to restore session: ${sessionId}`);
  } catch (error) {
    console.error(`❌ Failed to restore session ${sessionId}:`, error.message);
    throw error;
  }
}

/* -----------------------------------------------------
   Get or restore a client
   - Returns client if exists, or tries to restore it
----------------------------------------------------- */
export async function getOrRestoreClient(sessionId) {
  try {
    // Clean sessionId
    sessionId = sessionId.trim();
    
    // Try to get existing client
    const client = clients.get(sessionId);
    if (client) {
      try {
        if (client.info) {
          // Get session name from database for display
          const sessionInfo = await sessionModel.findOne({ sessionId });
          const displayName = sessionInfo?.sessionName || sessionId;
          const phoneNumber = client.info?.wid?.user || 'Unknown';
          console.log(`✅ Using: "${displayName}" (${sessionInfo?.userId || 'unknown'}) - Phone: +${phoneNumber}`);
          return client;
        }
      } catch (e) {
        // Client exists but not ready
        console.log(`⚠️ Client exists but not ready for ${sessionId}`);
      }
    }

    // If not in memory, try to restore
    console.log(`🔄 Session not in memory, attempting to restore: ${sessionId}`);
    const restoredClient = await restoreSession(sessionId);
    
    // Verify the restored client is actually ready
    if (!restoredClient.info) {
      throw new Error(`Session ${sessionId} restored but not connected to WhatsApp. Please scan QR code or use an active session.`);
    }
    
    return restoredClient;
  } catch (error) {
    console.error(`❌ getOrRestoreClient failed for ${sessionId}:`, error.message);
    throw new Error(`Session ${sessionId} is not available. ${error.message}`);
  }
}

/* -----------------------------------------------------
   Get all active sessions info
----------------------------------------------------- */
export function getAllActiveSessions() {
  const activeSessions = [];
  for (const [sessionId, client] of clients.entries()) {
    try {
      const info = {
        sessionId,
        isReady: !!client.info,
        phoneNumber: client.info?.wid?.user || null,
        pushname: client.info?.pushname || null,
      };
      activeSessions.push(info);
    } catch (e) {
      activeSessions.push({
        sessionId,
        isReady: false,
        phoneNumber: null,
        pushname: null,
      });
    }
  }
  return activeSessions;
}

/* -----------------------------------------------------
   Check if session is active and ready
----------------------------------------------------- */
export async function isSessionActive(sessionId) {
  const client = clients.get(sessionId);
  if (!client) return false;

  try {
    // Check if client has info (means it's ready)
    if (client.info) return true;
    // Check puppeteer page
    if (client.pupPage && !client.pupPage.isClosed()) return true;
    return false;
  } catch {
    return false;
  }
}

/* -----------------------------------------------------
   Restore sessions from DB on startup
   Restores all previously connected sessions
----------------------------------------------------- */
export async function restoreSessions() {
  try {
    // Only restore connected/authenticated sessions
    const sessions = await sessionModel.find({
      status: { $in: ["connected", "authenticated"] },
    });

    if (!sessions.length) {
      console.log("ℹ️ No sessions to restore");
      return;
    }

    console.log(`♻️ Restoring ${sessions.length} session(s)...`);

    // Restore sessions in parallel with error handling
    const restorePromises = sessions.map(async (session, index) => {
      try {
        if (!clients.has(session.sessionId)) {
          await delay(index * 1000);
          await createClient(session.userId, session.sessionId, session.sessionName);
        }
      } catch (err) {
        console.error(`❌ Failed to restore ${session.sessionId}:`, err.message);
        // Mark session as failed
        await sessionModel.findOneAndUpdate(
          { sessionId: session.sessionId },
          { status: "disconnected", updatedAt: new Date() }
        );
      }
    });

    await Promise.allSettled(restorePromises);
    
    const activeCount = clients.size;
    console.log(`✅ Session restoration complete (${activeCount} active client(s))`);
  } catch (error) {
    console.error("❌ Error in restoreSessions:", error.message);
  }
}
