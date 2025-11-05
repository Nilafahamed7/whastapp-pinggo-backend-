// controllers/message.controller.js
import { getClient, getActiveClient, getOrRestoreClient } from "../services/waManager.js";
import pkg from "whatsapp-web.js";
const { MessageMedia } = pkg;
import fs from "fs";
import path from "path";
import mime from "mime-types";
import xlsx from "xlsx";

/**
 * ✅ POST /wa/message/send
 * Send a simple text message
 */

export const sendMessage = async (req, res) => {
  const { sessionId, to, text } = req.body;

  if (!sessionId || !to || !text)
    return res.status(400).json({ error: "sessionId, to, and text required" });

  try {
    // Get or restore the client automatically
    const client = await getOrRestoreClient(sessionId);
    
    // Verify client is ready
    if (!client.info) {
      return res.status(400).json({ error: "Session not ready yet. Please wait for connection." });
    }

    // Resolve recipient (supports group names, IDs, or phone numbers)
    const resolved = await resolveRecipient(client, to);
    const chatId = resolved.id;
    
    if (!chatId) {
      return res.status(400).json({ error: `Could not resolve recipient: ${to}` });
    }

    const msg = await client.sendMessage(chatId, text);
    return res.json({ 
      success: true,
      messageId: msg.id._serialized,
      to: chatId,
      originalRecipient: to,
      groupName: resolved.name,
      sessionId 
    });
  } catch (err) {
    console.error(`❌ Error sending message via ${sessionId}:`, err.message);
    return res.status(500).json({ 
      error: "Failed to send message",
      details: err.message 
    });
  }
};

/**
 * ✅ POST /wa/message/send-batch
 * Send message to multiple recipients
 */
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const randomDelay = (min, max) =>
  Math.floor(Math.random() * (max - min + 1)) + min;

const fileToBase64 = (filePath) => fs.readFileSync(filePath).toString("base64");

const safeUnlink = (filePath) => {
  try {
    fs.unlinkSync(filePath);
  } catch {}
};

// Helper to format recipient IDs
const formatRecipientId = (id) => {
  // If already formatted, return as is
  if (id.includes('@g.us') || id.includes('@c.us')) {
    return id;
  }
  
  // If it contains a dash, it's likely a group ID
  if (id.includes('-')) {
    return `${id}@g.us`;
  }
  
  // Otherwise, it's a phone number (individual chat)
  // Remove any non-digit characters
  const cleanNumber = id.replace(/\D/g, '');
  return `${cleanNumber}@c.us`;
};

// Helper to resolve group name to ID
const resolveRecipient = async (client, recipient) => {
  // If already formatted with @, return as is
  if (recipient.includes('@g.us') || recipient.includes('@c.us')) {
    return { id: recipient, name: null };
  }
  
  // If it looks like a group ID format (contains dash), format and return
  if (recipient.includes('-')) {
    return { id: `${recipient}@g.us`, name: null };
  }
  
  // Check if it's a phone number (only digits after cleaning)
  const cleanNumber = recipient.replace(/\D/g, '');
  if (cleanNumber.length >= 10 && cleanNumber === recipient.replace(/[\s\-\+]/g, '')) {
    return { id: `${cleanNumber}@c.us`, name: null };
  }
  
  // Otherwise, treat it as a group name and search for it
  try {
    const chats = await client.getChats();
    const matchingChat = chats.find(chat => 
      chat.isGroup && chat.name && chat.name.toLowerCase() === recipient.toLowerCase()
    );
    
    if (matchingChat) {
      return { 
        id: matchingChat.id._serialized, 
        name: matchingChat.name,
        found: true 
      };
    }
    
    // Try partial match if exact match not found
    const partialMatch = chats.find(chat => 
      chat.isGroup && chat.name && chat.name.toLowerCase().includes(recipient.toLowerCase())
    );
    
    if (partialMatch) {
      return { 
        id: partialMatch.id._serialized, 
        name: partialMatch.name,
        found: true,
        partialMatch: true
      };
    }
    
    // Not found, return null
    return { id: null, name: recipient, found: false };
  } catch (err) {
    console.error(`Error resolving recipient ${recipient}:`, err.message);
    return { id: null, name: recipient, found: false, error: err.message };
  }
};

export const sendBatchMessage = async (req, res) => {
  try {
    let {
      sessionIds,
      to,
      text,
      mediaUrls,
      delayMin = 15000,
      delayMax = 20000,
    } = req.body;

    if (typeof sessionIds === "string") sessionIds = JSON.parse(sessionIds);
    if (typeof to === "string") to = JSON.parse(to);
    if (typeof mediaUrls === "string") mediaUrls = JSON.parse(mediaUrls);

    if (!sessionIds?.length)
      return res.status(400).json({ error: "sessionIds (array) required" });
    if (!to?.length)
      return res.status(400).json({ error: "to (array) required" });
    
    // Text is optional if media files are present
    const hasMediaFiles = (req.files?.length > 0) || (mediaUrls?.length > 0);
    if (!text?.trim() && !hasMediaFiles)
      return res.status(400).json({ error: "text or media files required" });

    const results = [];
    const uploadedFiles = [];

    // Handle local media uploads - store file data (not MessageMedia objects)
    const localMediaData = [];
    if (req.files?.length > 0) {
      for (const file of req.files) {
        const filePath = path.resolve(file.path);
        const mimeType = mime.lookup(file.originalname) || "application/octet-stream";
        const base64 = fileToBase64(filePath);
        
        localMediaData.push({
          mimeType,
          base64,
          filename: file.originalname
        });
        uploadedFiles.push(filePath);
      }
      console.log(`📎 ${localMediaData.length} media file(s) attached`);
    }

    // Remote media URLs
    const remoteMediaList = [];
    if (mediaUrls?.length) {
      for (const url of mediaUrls) {
        const media = await MessageMedia.fromUrl(url, { unsafeMime: true });
        remoteMediaList.push(media);
      }
    }

    const hasMedia = localMediaData.length > 0 || remoteMediaList.length > 0;

    console.log(`🚀 Batch sending to ${to.length} recipient(s) via ${sessionIds.length} session(s) with 15-20s delay between each message`);

    // Prepare all clients first
    const clientMap = new Map();
    for (const sessionId of sessionIds) {
      try {
        const client = await getOrRestoreClient(sessionId);
        if (!client.info) {
          console.error(`❌ ${sessionId}: Client not ready yet`);
          results.push({ sessionId, error: "Client not ready yet" });
          continue;
        }
        clientMap.set(sessionId, client);
      } catch (err) {
        console.error(`❌ ${sessionId}: ${err.message}`);
        results.push({ sessionId, error: err.message });
      }
    }

    // Round-robin: alternate between sessions for each recipient
    // Example: Session1→Group1, Session2→Group1, Session1→Group2, Session2→Group2...
    let messageCount = 0;
    for (const recipient of to) {
      for (const sessionId of sessionIds) {
        const client = clientMap.get(sessionId);
        if (!client) {
          console.error(`❌ Skipping ${sessionId} - client not available`);
          continue;
        }

        try {
          // Resolve recipient (supports group names, IDs, or phone numbers)
          const resolved = await resolveRecipient(client, recipient);
          
          if (!resolved.id) {
            console.error(`❌ Recipient not found: "${recipient}" via ${sessionId}`);
            results.push({
              sessionId,
              to: recipient,
              status: "failed",
              error: `Recipient not found: ${recipient}`,
            });
            continue;
          }
          
          const recipientId = resolved.id;
          const groupName = resolved.name || recipient;

          if (!hasMedia) {
            // Send text-only message (if text is provided)
            if (text?.trim()) {
              const msg = await client.sendMessage(recipientId, text);
              messageCount++;
              console.log(`✅ [${messageCount}] Sent text to "${groupName}" via ${sessionId}`);
              results.push({
                sessionId,
                to: recipientId,
                originalRecipient: recipient,
                groupName,
                type: "text",
                status: "sent",
                messageId: msg.id._serialized,
              });
            }
          } else {
            // Send local media files (create NEW MessageMedia for each recipient)
            for (let i = 0; i < localMediaData.length; i++) {
              const mediaData = localMediaData[i];
              // Create a NEW MessageMedia object for this recipient
              const media = new MessageMedia(
                mediaData.mimeType,
                mediaData.base64,
                mediaData.filename
              );
              
              const options = {};
              if (i === 0 && text?.trim()) options.caption = text;

              const msg = await client.sendMessage(recipientId, media, options);
              messageCount++;
              console.log(`✅ [${messageCount}] Sent ${mediaData.filename} to "${groupName}" via ${sessionId}`);
              results.push({
                sessionId,
                to: recipientId,
                originalRecipient: recipient,
                groupName,
                type: mediaData.mimeType,
                filename: mediaData.filename,
                status: "sent",
                messageId: msg.id._serialized,
              });
            }
            
            // Send remote media URLs
            for (let i = 0; i < remoteMediaList.length; i++) {
              const media = remoteMediaList[i];
              const options = {};
              if (localMediaData.length === 0 && i === 0 && text?.trim()) {
                options.caption = text;
              }

              const msg = await client.sendMessage(recipientId, media, options);
              messageCount++;
              console.log(`✅ [${messageCount}] Sent remote media to "${groupName}" via ${sessionId}`);
              results.push({
                sessionId,
                to: recipientId,
                originalRecipient: recipient,
                groupName,
                type: media.mimetype,
                status: "sent",
                messageId: msg.id._serialized,
              });
            }
          }

          // Add delay between every message globally (across all sessions)
          const wait = randomDelay(delayMin, delayMax);
          console.log(`⏱️ Waiting ${(wait / 1000).toFixed(1)}s before next message...`);
          await delay(wait);
        } catch (err) {
          console.error(
            `❌ Failed to send to "${recipient}" via ${sessionId}:`,
            err.message
          );
          results.push({
            sessionId,
            to: recipient,
            status: "failed",
            error: err.message,
          });
        }
      }
    }

    for (const filePath of uploadedFiles) safeUnlink(filePath);

    return res.json({
      success: true,
      total: results.length,
      results,
    });
  } catch (err) {
    console.error("❌ Controller error:", err);
    return res.status(500).json({
      error: "Failed to send batch messages",
      details: err.message,
    });
  }
};

/**
 * ✅ POST /wa/message/reply
 * Reply to a specific message (quote)
 */
export const replyMessage = async (req, res) => {
  const { sessionId, to, text, replyTo } = req.body;

  if (!sessionId || !to || !text || !replyTo)
    return res
      .status(400)
      .json({ error: "sessionId, to, text, and replyTo required" });

  try {
    const client = await getOrRestoreClient(sessionId);
    
    if (!client.info) {
      return res.status(400).json({ error: "Session not ready yet" });
    }

    // Resolve recipient (supports group names, IDs, or phone numbers)
    const resolved = await resolveRecipient(client, to);
    const chatId = resolved.id;
    
    if (!chatId) {
      return res.status(400).json({ error: `Could not resolve recipient: ${to}` });
    }

    const chat = await client.getChatById(chatId);
    const quotedMsg = await chat.fetchMessages({ limit: 50 });
    const msgToReply = quotedMsg.find((m) => m.id._serialized === replyTo);

    if (!msgToReply)
      return res.status(404).json({ error: "Message to reply not found" });

    const sentMsg = await msgToReply.reply(text);
    return res.json({ 
      success: true,
      messageId: sentMsg.id._serialized,
      to: chatId,
      originalRecipient: to,
      groupName: resolved.name
    });
  } catch (err) {
    console.error(`❌ Error replying to message via ${sessionId}:`, err.message);
    return res.status(500).json({ 
      error: "Failed to reply to message",
      details: err.message 
    });
  }
};

/**
 * ✅ POST /wa/message/react
 * React to a message
 */
export const reactToMessage = async (req, res) => {
  const { sessionId, messageId, reaction } = req.body;

  if (!sessionId || !messageId || !reaction)
    return res
      .status(400)
      .json({ error: "sessionId, messageId, and reaction required" });

  try {
    const client = await getOrRestoreClient(sessionId);
    
    if (!client.info) {
      return res.status(400).json({ error: "Session not ready yet" });
    }

    const msg = await client.getMessageById(messageId);
    await msg.react(reaction);

    return res.json({ 
      success: true,
      status: "reacted",
      reaction 
    });
  } catch (err) {
    console.error(`❌ Error reacting to message via ${sessionId}:`, err.message);
    return res.status(500).json({ 
      error: "Failed to react to message",
      details: err.message 
    });
  }
};

// debug

export const debugGroups = async (req, res) => {
  const { sessionId, search } = req.query;
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });

  try {
    const client = await getOrRestoreClient(sessionId);
    
    if (!client.info) {
      return res.status(400).json({ error: "Session not ready yet" });
    }

    const chats = await client.getChats();
    let groups = chats
      .filter((c) => c.isGroup)
      .map((g) => ({
        id: g.id._serialized,
        name: g.name,
        participantsCount: g.participants?.length || 0,
      }));

    // Filter by search term if provided
    if (search) {
      const searchLower = search.toLowerCase();
      groups = groups.filter(g => 
        g.name.toLowerCase().includes(searchLower)
      );
    }

    return res.json({ 
      success: true,
      sessionId,
      total: groups.length, 
      groups,
      usage: {
        byId: "Use the 'id' field: ['120363123456789@g.us']",
        byName: "Use the 'name' field: ['test group 2.0', 'test group 3.0']",
        mixed: "Mix both: ['test group 2.0', '120363987654321@g.us', '1234567890']"
      }
    });
  } catch (err) {
    console.error(`❌ Debug groups failed for ${sessionId}:`, err.message);
    return res.status(500).json({ 
      error: "Failed to get groups",
      details: err.message 
    });
  }
};

/**
 * ✅ POST /wa/message/send-batch-excel
 * Send batch messages from Excel file upload with optional media
 */
export const sendBatchFromExcel = async (req, res) => {
  try {
    let {
      sessionIds,
      text,
      delayMin = 15000,
      delayMax = 20000,
    } = req.body;

    // Parse sessionIds if string
    if (typeof sessionIds === "string") {
      try {
        sessionIds = JSON.parse(sessionIds);
      } catch {
        sessionIds = [sessionIds];
      }
    }

    // Validation
    if (!sessionIds?.length) {
      return res.status(400).json({ error: "sessionIds (array) required" });
    }
    if (!req.files?.excel?.[0]) {
      return res.status(400).json({ error: "Excel file required" });
    }
    
    // Text is optional if media file is present
    const hasMedia = req.files?.media?.[0];
    if (!text?.trim() && !hasMedia) {
      return res.status(400).json({ error: "text or media file required" });
    }

    const excelFile = req.files.excel[0];
    const mediaFile = req.files?.media?.[0];
    const uploadedFiles = [excelFile.path];

    try {
      // Parse Excel file
      console.log(`📊 Parsing Excel file: ${excelFile.originalname}`);
      const workbook = xlsx.readFile(excelFile.path);
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const data = xlsx.utils.sheet_to_json(worksheet, { header: 1 });

      // Extract phone numbers from Excel
      const contacts = [];
      const headers = data[0] || [];
      
      // Find phone column index (look for "Phone", "Number", or use column A)
      let phoneColIndex = 0;
      let nameColIndex = 1;
      
      if (Array.isArray(headers) && headers.length > 0) {
        const phoneCol = headers.findIndex(h => 
          h && typeof h === 'string' && 
          (h.toLowerCase().includes('phone') || h.toLowerCase().includes('number'))
        );
        const nameCol = headers.findIndex(h => 
          h && typeof h === 'string' && h.toLowerCase().includes('name')
        );
        
        if (phoneCol !== -1) phoneColIndex = phoneCol;
        if (nameCol !== -1) nameColIndex = nameCol;
      }

      // Extract contacts (skip header row)
      for (let i = 1; i < data.length; i++) {
        const row = data[i];
        if (!row || !Array.isArray(row)) continue;
        
        const phone = row[phoneColIndex];
        const name = row[nameColIndex];
        
        if (phone) {
          // Clean phone number (remove spaces, dashes, but keep + for country code)
          const cleanedPhone = String(phone).replace(/[\s\-]/g, '');
          if (cleanedPhone && cleanedPhone.length >= 10) {
            contacts.push({
              phone: cleanedPhone,
              name: name || cleanedPhone
            });
          }
        }
      }

      if (contacts.length === 0) {
        // Clean up uploaded files
        safeUnlink(excelFile.path);
        if (mediaFile) safeUnlink(mediaFile.path);
        return res.status(400).json({ 
          error: "No valid phone numbers found in Excel file",
          hint: "Ensure phone numbers are in column A or in a column named 'Phone'"
        });
      }

      console.log(`✅ Found ${contacts.length} contacts in Excel`);

      // Process media file if uploaded
      let media = null;
      if (mediaFile) {
        uploadedFiles.push(mediaFile.path);
        const filePath = path.resolve(mediaFile.path);
        const mimeType = mime.lookup(mediaFile.originalname) || "application/octet-stream";
        const base64 = fileToBase64(filePath);
        media = new MessageMedia(mimeType, base64, mediaFile.originalname);
        console.log(`📎 Media attached: ${mediaFile.originalname}`);
      }

      const results = [];

      // Prepare all clients first
      const clientMap = new Map();
      for (const sessionId of sessionIds) {
        try {
          const client = await getOrRestoreClient(sessionId);
          if (!client.info) {
            console.error(`❌ ${sessionId}: Client not ready yet`);
            results.push({ sessionId, error: "Client not ready yet" });
            continue;
          }
          clientMap.set(sessionId, client);
        } catch (err) {
          console.error(`❌ ${sessionId}: ${err.message}`);
          results.push({ sessionId, error: err.message });
        }
      }

      console.log(`🚀 Sending to ${contacts.length} contacts via ${sessionIds.length} session(s)`);

      // Send messages to all contacts
      let messageCount = 0;
      for (const contact of contacts) {
        for (const sessionId of sessionIds) {
          const client = clientMap.get(sessionId);
          if (!client) {
            console.error(`❌ Skipping ${sessionId} - client not available`);
            continue;
          }

          try {
            // Resolve recipient
            const resolved = await resolveRecipient(client, contact.phone);
            
            if (!resolved.id) {
              console.error(`❌ Could not resolve: ${contact.name} (${contact.phone})`);
              results.push({
                status: "failed",
                sessionId,
                to: contact.phone,
                originalRecipient: contact.name,
                error: `Could not resolve recipient: ${contact.phone}`
              });
              continue;
            }

            // Send message (with or without media)
            let msg;
            if (media) {
              msg = await client.sendMessage(resolved.id, media, { caption: text.trim() });
            } else {
              msg = await client.sendMessage(resolved.id, text.trim());
            }

            console.log(`✅ ${sessionId} → ${contact.name} (${resolved.id})`);
            
            results.push({
              status: "sent",
              sessionId,
              to: resolved.id,
              originalRecipient: contact.name,
              groupName: resolved.name,
              messageId: msg.id._serialized
            });

            messageCount++;

            // Apply delay between messages (except for last message)
            if (messageCount < contacts.length * sessionIds.length) {
              const delayTime = randomDelay(delayMin, delayMax);
              console.log(`⏳ Waiting ${delayTime}ms...`);
              await delay(delayTime);
            }

          } catch (err) {
            console.error(`❌ ${sessionId} → ${contact.name}: ${err.message}`);
            results.push({
              status: "failed",
              sessionId,
              to: contact.phone,
              originalRecipient: contact.name,
              error: err.message
            });
          }
        }
      }

      // Clean up uploaded files
      uploadedFiles.forEach(safeUnlink);

      const successCount = results.filter(r => r.status === "sent").length;
      const failCount = results.filter(r => r.status === "failed").length;

      console.log(`✅ Batch complete: ${successCount} sent, ${failCount} failed`);

      return res.json({
        success: true,
        total: results.length,
        sent: successCount,
        failed: failCount,
        contacts: contacts.length,
        results
      });

    } catch (parseError) {
      // Clean up uploaded files on error
      uploadedFiles.forEach(safeUnlink);
      
      console.error(`❌ Error processing Excel:`, parseError.message);
      return res.status(500).json({
        error: "Failed to process Excel file",
        details: parseError.message
      });
    }

  } catch (err) {
    console.error(`❌ Error in sendBatchFromExcel:`, err.message);
    return res.status(500).json({
      error: "Failed to send batch from Excel",
      details: err.message
    });
  }
};

/**
 * ✅ POST /wa/message/send-batch-to-group
 * Send private messages to all members of a group individually
 */
export const sendBatchToGroupMembers = async (req, res) => {
  try {
    let {
      sessionId,
      groupId,
      text,
      delayMin = 15000,  // Already in milliseconds from frontend
      delayMax = 20000,   // Already in milliseconds from frontend
    } = req.body;
    
    // Parse delays as integers (they come as strings from FormData)
    delayMin = parseInt(delayMin) || 15000;
    delayMax = parseInt(delayMax) || 20000;

    // Validation
    if (!sessionId) {
      return res.status(400).json({ error: "sessionId required" });
    }
    if (!groupId) {
      return res.status(400).json({ error: "groupId required" });
    }
    
    // Text is optional if media files are present
    const hasMediaFiles = (req.files?.files?.length > 0) || (req.files?.media?.[0]);
    if (!text?.trim() && !hasMediaFiles) {
      return res.status(400).json({ error: "text or media files required" });
    }

    const uploadedFiles = [];

    try {
      const client = await getOrRestoreClient(sessionId);
      if (!client.info) {
        return res.status(400).json({ error: "Session not ready yet" });
      }

      // Fetch group participants
      console.log(`👥 Fetching members from group: ${groupId}`);
      
      // Resolve group name to ID if needed
      let resolvedGroupId = groupId;
      if (!groupId.includes('@g.us')) {
        console.log(`🔍 Searching for group: "${groupId}"`);
        const chats = await client.getChats();
        const matchingGroup = chats.find(chat => 
          chat.isGroup && chat.name && chat.name.toLowerCase() === groupId.toLowerCase()
        );
        
        if (matchingGroup) {
          resolvedGroupId = matchingGroup.id._serialized;
        } else {
          return res.status(404).json({ 
            error: `Group not found: ${groupId}`,
            hint: "Use exact group name or group ID (e.g., '120363123456789@g.us')"
          });
        }
      }

      const chat = await client.getChatById(resolvedGroupId);
      if (!chat.isGroup) {
        return res.status(400).json({ error: "Not a group chat" });
      }

      // Extract participants
      const participants = chat.participants || [];
      if (participants.length === 0) {
        return res.status(400).json({ error: "No members found in group" });
      }

      // Build contact list from participants
      const contacts = [];
      for (const p of participants) {
        const contact = await client.getContactById(p.id._serialized);
        contacts.push({
          waId: p.id._serialized,
          phone: contact.id.user, // phone number without @c.us
          name: contact.pushname || contact.name || contact.number || contact.id.user
        });
      }

      console.log(`✅ Found ${contacts.length} members in group "${chat.name}"`);

      // Process media files if uploaded - store file data (support both 'files' and 'media')
      const mediaDataList = [];
      
      // Handle multiple files from 'files' field
      if (req.files?.files?.length > 0) {
        for (const file of req.files.files) {
          uploadedFiles.push(file.path);
          const filePath = path.resolve(file.path);
          const mimeType = mime.lookup(file.originalname) || "application/octet-stream";
          const base64 = fileToBase64(filePath);
          mediaDataList.push({
            mimeType,
            base64,
            filename: file.originalname
          });
        }
        console.log(`📎 ${mediaDataList.length} media file(s) attached`);
      }
      // Handle single file from 'media' field (fallback for old group media upload)
      else if (req.files?.media?.[0]) {
        const file = req.files.media[0];
        uploadedFiles.push(file.path);
        const filePath = path.resolve(file.path);
        const mimeType = mime.lookup(file.originalname) || "application/octet-stream";
        const base64 = fileToBase64(filePath);
        mediaDataList.push({
          mimeType,
          base64,
          filename: file.originalname
        });
        console.log(`📎 Media attached: ${file.originalname}`);
      }

      const results = [];

      console.log(`🚀 Sending private messages to ${contacts.length} group members`);
      console.log(`⏱️  Delay settings: ${delayMin}ms - ${delayMax}ms per message`);

      // Send messages to all group members privately
      let messageCount = 0;
      for (const contact of contacts) {
        try {
          // Send message (with or without media)
          if (mediaDataList.length === 0) {
            // Text-only message
            if (text?.trim()) {
              const msg = await client.sendMessage(contact.waId, text.trim());
              console.log(`✅ Sent text to ${contact.name} (${contact.waId})`);
              
              results.push({
                status: "sent",
                to: contact.waId,
                name: contact.name,
                phone: contact.phone,
                type: "text",
                messageId: msg.id._serialized
              });
              messageCount++;
            }
          } else {
            // Send all media files to this contact
            for (let i = 0; i < mediaDataList.length; i++) {
              const mediaData = mediaDataList[i];
              // Create a NEW MessageMedia object for this recipient
              const media = new MessageMedia(
                mediaData.mimeType,
                mediaData.base64,
                mediaData.filename
              );
              
              const options = {};
              if (i === 0 && text?.trim()) {
                options.caption = text.trim();
              }

              const msg = await client.sendMessage(contact.waId, media, options);
              console.log(`✅ Sent ${mediaData.filename} to ${contact.name} (${contact.waId})`);
              
              results.push({
                status: "sent",
                to: contact.waId,
                name: contact.name,
                phone: contact.phone,
                type: mediaData.mimeType,
                filename: mediaData.filename,
                messageId: msg.id._serialized
              });
              messageCount++;
            }
          }

          // Apply delay between recipients (not between each media file)
          const totalRecipients = contacts.length;
          const currentRecipientIndex = contacts.indexOf(contact);
          if (currentRecipientIndex < totalRecipients - 1) {
            const delayTime = randomDelay(delayMin, delayMax);
            console.log(`⏳ Waiting ${delayTime}ms before next recipient...`);
            await delay(delayTime);
          }

        } catch (err) {
          console.error(`❌ Failed to send to ${contact.name}: ${err.message}`);
          results.push({
            status: "failed",
            to: contact.waId,
            name: contact.name,
            phone: contact.phone,
            error: err.message
          });
        }
      }

      // Clean up uploaded files
      uploadedFiles.forEach(safeUnlink);

      const successCount = results.filter(r => r.status === "sent").length;
      const failCount = results.filter(r => r.status === "failed").length;

      console.log(`✅ Batch complete: ${successCount} sent, ${failCount} failed`);

      return res.json({
        success: true,
        groupId: resolvedGroupId,
        groupName: chat.name,
        total: results.length,
        sent: successCount,
        failed: failCount,
        results
      });

    } catch (parseError) {
      // Clean up uploaded files on error
      uploadedFiles.forEach(safeUnlink);
      
      console.error(`❌ Error processing group members:`, parseError.message);
      return res.status(500).json({
        error: "Failed to process group members",
        details: parseError.message
      });
    }

  } catch (err) {
    console.error(`❌ Error in sendBatchToGroupMembers:`, err.message);
    return res.status(500).json({
      error: "Failed to send batch to group members",
      details: err.message
    });
  }
};

/**
 * ✅ POST /wa/message/send-batch-to-multiple-groups
 * Send private messages to all unique members from multiple groups
 */
export const sendBatchToMultipleGroups = async (req, res) => {
  try {
    let {
      sessionId,
      groupIds, // JSON array of group IDs
      text,
      delayMin = 15000,
      delayMax = 20000,
    } = req.body;

    // Parse groupIds if it's a string
    if (typeof groupIds === 'string') {
      try {
        groupIds = JSON.parse(groupIds);
      } catch (e) {
        return res.status(400).json({ error: "Invalid groupIds format. Must be JSON array." });
      }
    }

    // Parse delays as integers
    delayMin = parseInt(delayMin) || 15000;
    delayMax = parseInt(delayMax) || 20000;

    // Validation
    if (!sessionId) {
      return res.status(400).json({ error: "sessionId required" });
    }
    if (!Array.isArray(groupIds) || groupIds.length === 0) {
      return res.status(400).json({ error: "groupIds array required with at least one group" });
    }

    // Text is optional if media files are present
    const hasMediaFiles = (req.files?.files?.length > 0) || (req.files?.media?.[0]);
    if (!text?.trim() && !hasMediaFiles) {
      return res.status(400).json({ error: "text or media files required" });
    }

    const uploadedFiles = [];

    try {
      const client = await getOrRestoreClient(sessionId);
      if (!client.info) {
        return res.status(400).json({ error: "Session not ready yet" });
      }

      console.log(`👥 Fetching members from ${groupIds.length} group(s)...`);

      // Collect all unique members from all groups
      const allContacts = [];
      const uniquePhones = new Set();
      const groupDetails = [];

      for (const groupId of groupIds) {
        try {
          // Resolve group name to ID if needed
          let resolvedGroupId = groupId;
          if (!groupId.includes('@g.us')) {
            console.log(`🔍 Searching for group: "${groupId}"`);
            const chats = await client.getChats();
            const matchingGroup = chats.find(chat =>
              chat.isGroup && chat.name && chat.name.toLowerCase() === groupId.toLowerCase()
            );

            if (matchingGroup) {
              resolvedGroupId = matchingGroup.id._serialized;
            } else {
              console.error(`⚠️ Group not found: ${groupId}`);
              continue;
            }
          }

          const chat = await client.getChatById(resolvedGroupId);
          if (!chat.isGroup) {
            console.error(`⚠️ Not a group chat: ${groupId}`);
            continue;
          }

          const participants = chat.participants || [];
          console.log(`✅ Found ${participants.length} members in "${chat.name}"`);

          groupDetails.push({
            id: resolvedGroupId,
            name: chat.name,
            memberCount: participants.length
          });

          // Add unique participants
          for (const p of participants) {
            const phoneNumber = p.id.user; // Extract phone without @c.us
            
            // Skip if already added
            if (uniquePhones.has(phoneNumber)) {
              continue;
            }

            uniquePhones.add(phoneNumber);
            const contact = await client.getContactById(p.id._serialized);
            allContacts.push({
              waId: p.id._serialized,
              phone: phoneNumber,
              name: contact.pushname || contact.name || contact.number || phoneNumber,
              fromGroup: chat.name
            });
          }
        } catch (groupErr) {
          console.error(`❌ Error processing group ${groupId}:`, groupErr.message);
        }
      }

      if (allContacts.length === 0) {
        return res.status(400).json({
          error: "No members found in any of the selected groups",
          groupDetails
        });
      }

      console.log(`✅ Total unique members across ${groupDetails.length} group(s): ${allContacts.length}`);

      // Process media files if uploaded
      const mediaDataList = [];

      // Handle multiple files from 'files' field
      if (req.files?.files?.length > 0) {
        for (const file of req.files.files) {
          uploadedFiles.push(file.path);
          const filePath = path.resolve(file.path);
          const mimeType = mime.lookup(file.originalname) || "application/octet-stream";
          const base64 = fileToBase64(filePath);
          mediaDataList.push({
            mimeType,
            base64,
            filename: file.originalname
          });
        }
        console.log(`📎 ${mediaDataList.length} media file(s) attached`);
      }
      // Handle single file from 'media' field (fallback)
      else if (req.files?.media?.[0]) {
        const file = req.files.media[0];
        uploadedFiles.push(file.path);
        const filePath = path.resolve(file.path);
        const mimeType = mime.lookup(file.originalname) || "application/octet-stream";
        const base64 = fileToBase64(filePath);
        mediaDataList.push({
          mimeType,
          base64,
          filename: file.originalname
        });
        console.log(`📎 Media attached: ${file.originalname}`);
      }

      const results = [];

      console.log(`🚀 Sending private messages to ${allContacts.length} unique members`);
      console.log(`⏱️  Delay settings: ${delayMin}ms - ${delayMax}ms per recipient`);

      // Send messages to all unique members privately
      let messageCount = 0;
      for (const contact of allContacts) {
        try {
          // Send message (with or without media)
          if (mediaDataList.length === 0) {
            // Text-only message
            if (text?.trim()) {
              const msg = await client.sendMessage(contact.waId, text.trim());
              console.log(`✅ Sent text to ${contact.name} (${contact.waId}) from "${contact.fromGroup}"`);

              results.push({
                status: "sent",
                to: contact.waId,
                name: contact.name,
                phone: contact.phone,
                fromGroup: contact.fromGroup,
                type: "text",
                messageId: msg.id._serialized
              });
              messageCount++;
            }
          } else {
            // Send all media files to this contact
            for (let i = 0; i < mediaDataList.length; i++) {
              const mediaData = mediaDataList[i];
              // Create a NEW MessageMedia object for this recipient
              const media = new MessageMedia(
                mediaData.mimeType,
                mediaData.base64,
                mediaData.filename
              );

              const options = {};
              if (i === 0 && text?.trim()) {
                options.caption = text.trim();
              }

              const msg = await client.sendMessage(contact.waId, media, options);
              console.log(`✅ Sent ${mediaData.filename} to ${contact.name} (${contact.waId}) from "${contact.fromGroup}"`);

              results.push({
                status: "sent",
                to: contact.waId,
                name: contact.name,
                phone: contact.phone,
                fromGroup: contact.fromGroup,
                type: mediaData.mimeType,
                filename: mediaData.filename,
                messageId: msg.id._serialized
              });
              messageCount++;
            }
          }

          // Apply delay between recipients
          const currentIndex = allContacts.indexOf(contact);
          if (currentIndex < allContacts.length - 1) {
            const delayTime = randomDelay(delayMin, delayMax);
            console.log(`⏳ Waiting ${delayTime}ms before next recipient...`);
            await delay(delayTime);
          }

        } catch (err) {
          console.error(`❌ Failed to send to ${contact.name}: ${err.message}`);
          results.push({
            status: "failed",
            to: contact.waId,
            name: contact.name,
            phone: contact.phone,
            fromGroup: contact.fromGroup,
            error: err.message
          });
        }
      }

      // Clean up uploaded files
      uploadedFiles.forEach(safeUnlink);

      const successCount = results.filter(r => r.status === "sent").length;
      const failCount = results.filter(r => r.status === "failed").length;

      console.log(`✅ Batch complete: ${successCount} sent, ${failCount} failed`);

      return res.json({
        success: true,
        groupsProcessed: groupDetails,
        totalGroups: groupDetails.length,
        uniqueMembers: allContacts.length,
        total: results.length,
        sent: successCount,
        failed: failCount,
        results
      });

    } catch (parseError) {
      // Clean up uploaded files on error
      uploadedFiles.forEach(safeUnlink);

      console.error(`❌ Error processing multiple groups:`, parseError.message);
      return res.status(500).json({
        error: "Failed to process multiple groups",
        details: parseError.message
      });
    }

  } catch (err) {
    console.error(`❌ Error in sendBatchToMultipleGroups:`, err.message);
    return res.status(500).json({
      error: "Failed to send batch to multiple groups",
      details: err.message
    });
  }
};
