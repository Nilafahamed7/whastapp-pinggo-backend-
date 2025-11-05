import { getClient, getOrRestoreClient } from "../services/waManager.js";
import fs from "fs";
import pkg from "whatsapp-web.js";
const { Buttons, Poll, Location } = pkg; 

//
// 🧩 1️⃣ Export Group Members
//
export const exportGroupMembers = async (req, res) => {
  try {
    // Support both params and query for groupId
    let { groupId } = req.params;
    const { sessionId } = req.query;
    
    // If groupId not in params, check query params
    if (!groupId) {
      groupId = req.query.groupId;
    }

    if (!sessionId || !groupId)
      return res.status(400).json({ error: "sessionId and groupId required" });

    const client = await getOrRestoreClient(sessionId);
    if (!client || !client.info)
      return res.status(400).json({ error: "Session not ready yet" });

    // Resolve group name to ID if needed
    if (!groupId.includes('@g.us')) {
      console.log(`🔍 Searching for group: "${groupId}"`);
      const chats = await client.getChats();
      const matchingGroup = chats.find(chat => 
        chat.isGroup && chat.name && chat.name.toLowerCase() === groupId.toLowerCase()
      );
      
      if (matchingGroup) {
        groupId = matchingGroup.id._serialized;
        console.log(`✅ Found group: "${req.params.groupId}" → ${groupId}`);
      } else {
        return res.status(404).json({ 
          error: `Group not found: ${groupId}`,
          hint: "Use exact group name or group ID"
        });
      }
    }

    const chat = await client.getChatById(groupId);
    if (!chat.isGroup)
      return res.status(400).json({ error: "Provided ID is not a group" });

    const members = [];

    for (const p of chat.participants) {
      // Fetch the full contact info for each participant
      const contact = await client.getContactById(p.id._serialized);

      members.push({
        waId: contact.id._serialized,
        phoneNumber: contact.id.user, // number only
        name:
          contact.name ||  // contact name in your phonebook (if saved)
          contact.pushname || // user's display name
          contact.shortName || // sometimes available
          p.id.user,
        isAdmin: p.isAdmin || false,
        isSuperAdmin: p.isSuperAdmin || false,
      });
    }

    return res.json({
      success: true,
      groupId,
      groupName: chat.name,
      totalMembers: members.length,
      members,
    });
  } catch (err) {
    console.error("❌ Error exporting group members:", err.message);
    return res.status(500).json({
      error: "Failed to export members",
      details: err.message,
    });
  }
};


//
// 🧩 2️⃣ Add Bulk Members
//
export const addBulkMembers = async (req, res) => {
  try {
    const { groupId } = req.params;
    const { sessionId, waIds } = req.body;

    if (!sessionId || !groupId || !waIds)
      return res
        .status(400)
        .json({ error: "sessionId, groupId, and waIds required" });

    const client = await getOrRestoreClient(sessionId);
    if (!client || !client.info)
      return res.status(400).json({ error: "Session not ready yet" });

    const chat = await client.getChatById(groupId);
    if (!chat.isGroup)
      return res.status(400).json({ error: "Provided ID is not a group" });

    const results = [];

    for (const waId of waIds) {
      try {
        await chat.addParticipants([waId]);
        results.push({ waId, status: "added" });
      } catch (e) {
        results.push({ waId, status: "failed", error: e.message });
      }
      await new Promise((r) => setTimeout(r, 500));
      // avoid rate limit
    }

    return res.json({ results });
  } catch (err) {
    console.error("❌ Error adding bulk members:", err);
    return res
      .status(500)
      .json({ error: "Failed to add members", details: err.message });
  }
};

//
// 🧩 3️⃣ Check Number Validity
//
export const checkNumberValidity = async (req, res) => {
  try {
    const { numbers, sessionId } = req.query;

    if (!sessionId || !numbers)
      return res.status(400).json({ error: "sessionId and numbers required" });

    const client = await getOrRestoreClient(sessionId);
    if (!client || !client.info)
      return res.status(400).json({ error: "Session not ready yet" });

    const numberList = numbers.split(",");
    const results = [];

    for (const num of numberList) {
      const waId = `${num}@c.us`;
      const exists = await client.isRegisteredUser(waId);
      results.push({ number: num, hasWhatsapp: exists });
    }

    return res.json({ results });
  } catch (err) {
    console.error("❌ Error checking number validity:", err);
    return res
      .status(500)
      .json({ error: "Failed to check validity", details: err.message });
  }
};

//
// 🧩 4️⃣ Get Contact Profile Picture
//
export const getProfilePic = async (req, res) => {
  try {
    const { waId, sessionId } = req.query;

    if (!sessionId || !waId)
      return res.status(400).json({ error: "sessionId and waId required" });

    const client = await getOrRestoreClient(sessionId);
    if (!client || !client.info)
      return res.status(400).json({ error: "Session not ready yet" });

    const profilePicUrl = await client.getProfilePicUrl(waId);

    return res.json({ waId, profilePicUrl });
  } catch (err) {
    console.error("❌ Error fetching profile pic:", err);
    return res
      .status(500)
      .json({ error: "Failed to fetch profile pic", details: err.message });
  }
};

//
// 🧩 5️⃣ Get Message History
//
export const getMessageHistory = async (req, res) => {
  try {
    const { sessionId, chatId } = req.query;

    if (!sessionId || !chatId)
      return res.status(400).json({ error: "sessionId and chatId required" });

    const client = await getOrRestoreClient(sessionId);
    if (!client || !client.info)
      return res.status(400).json({ error: "Session not ready yet" });

    const chat = await client.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit: 50 });

    const formatted = messages.map((m) => ({
      messageId: m.id._serialized,
      from: m.from,
      body: m.body,
      timestamp: m.timestamp,
      type: m.type,
    }));

    return res.json(formatted);
  } catch (err) {
    console.error("❌ Error getting message history:", err);
    return res
      .status(500)
      .json({ error: "Failed to get messages", details: err.message });
  }
};

// -------------------------------------
//          ✅ POLL
// --------------------------------------

/* ---------------------------------------------------
   🧠 Ensure WhatsApp Client is Ready
--------------------------------------------------- */
async function ensureClientReady(client) {
  let retries = 0;
  const maxRetries = 20;

  while (retries < maxRetries) {
    if (client.isReady && client.pupPage && typeof client.getChats === "function") {
      return;
    }
    if (retries === 0) console.log("⏳ Waiting for WhatsApp client to be ready...");
    await new Promise((r) => setTimeout(r, 1500));
    retries++;
  }

  throw new Error("Client not ready (still initializing WhatsApp Web)");
}


/* ---------------------------------------------------
   🔍 Helper: Resolve Chat ID
--------------------------------------------------- */
async function resolveChatId(client, target) {
  const chats = await client.getChats();
  if (!target) return null;

  if (target.endsWith("@g.us") || target.endsWith("@c.us")) {
    const found = chats.find((c) => c.id._serialized === target);
    return found ? found.id._serialized : null;
  }

  const match = chats.find(
    (c) => c.isGroup && c.name?.toLowerCase().trim() === target.toLowerCase().trim()
  );
  if (match) return match.id._serialized;

  if (/^\d+$/.test(target)) return `${target}@c.us`;
  return null;
}

/* ---------------------------------------------------
   📊 Create Poll Endpoint
--------------------------------------------------- */
export const createPoll = async (req, res) => {
  try {
    const { sessionId, group, question, options, allowMultipleAnswers = false } = req.body;

    if (!sessionId || !group || !question || !Array.isArray(options) || options.length === 0) {
      return res.status(400).json({
        error: "sessionId, group, question, and options[] are required",
      });
    }

    const client = await getOrRestoreClient(sessionId);
    if (!client || !client.info) {
      return res.status(400).json({ error: "Session not ready yet" });
    }

    // Resolve group name to ID
    let groupId = await resolveChatId(client, group);
    
    if (!groupId) {
      const chats = await client.getChats();
      const matchingGroup = chats.find(chat => 
        chat.isGroup && chat.name && chat.name.toLowerCase() === group.toLowerCase()
      );
      
      if (matchingGroup) {
        groupId = matchingGroup.id._serialized;
      } else {
        return res.status(404).json({ 
          error: `Group not found: ${group}`,
          hint: "Use exact group name or group ID"
        });
      }
    }

    // Get the chat object
    const chat = await client.getChatById(groupId);
    
    // Create native WhatsApp Poll using Poll class
    try {
      const poll = new Poll(question, options, { 
        allowMultipleAnswers: allowMultipleAnswers,
        messageSecret: Array(32).fill(0).map(() => Math.floor(Math.random() * 256))
      });
      
      const msg = await client.sendMessage(groupId, poll);
      
      return res.json({
        success: true,
        method: "native_poll",
        groupId,
        groupName: chat.name,
        question,
        optionsCount: options.length,
        allowMultipleAnswers,
        messageId: msg?.id?._serialized || null,
      });
    } catch (pollErr) {
      // Fallback: Send as beautifully formatted text
      const pollText = `📊 *${question}*\n\n${options
        .map((o, i) => {
          const emoji = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'][i];
          return `${emoji || `${i+1}.`} ${o}`;
        })
        .join("\n")}\n\n💬 _Reply with the number to vote${allowMultipleAnswers ? ' (multiple choices allowed)' : ''}._`;

      const msg = await client.sendMessage(groupId, pollText);

      return res.json({
        success: true,
        method: "formatted_text",
        groupId,
        groupName: chat.name,
        question,
        optionsCount: options.length,
        messageId: msg?.id?._serialized || null,
      });
    }
  } catch (err) {
    console.error("❌ Error creating poll:", err.message);
    return res.status(500).json({ 
      error: "Failed to create poll", 
      details: err.message 
    });
  }
};


/* ---------------------------------------------------
   📺 List All Channels
--------------------------------------------------- */
export const listChannels = async (req, res) => {
  try {
    const { sessionId } = req.query;

    if (!sessionId) {
      return res.status(400).json({ error: "sessionId required" });
    }

    const client = await getOrRestoreClient(sessionId);
    if (!client || !client.info) {
      return res.status(400).json({ error: "Session not ready yet" });
    }

    console.log(`📺 Fetching channels for session: ${sessionId}`);

    // Get all chats and filter for channels
    const chats = await client.getChats();
    
    // Debug: Log all chat types
    console.log(`📋 Total chats: ${chats.length}`);
    const chatTypes = {};
    chats.forEach(chat => {
      const type = chat.type || 'unknown';
      chatTypes[type] = (chatTypes[type] || 0) + 1;
      
      // Log channel candidates for debugging
      if (chat.isChannel || chat.type === 'newsletter' || chat.id._serialized.includes('@newsletter')) {
        console.log(`🔍 Potential channel:`, {
          id: chat.id._serialized,
          name: chat.name,
          type: chat.type,
          isChannel: chat.isChannel,
          isNewsletter: chat.id._serialized.includes('@newsletter')
        });
      }
    });
    console.log(`📊 Chat types breakdown:`, chatTypes);
    
    // Filter for channels (multiple detection methods)
    const channels = chats
      .filter((chat) => 
        chat.isChannel || 
        chat.type === 'newsletter' || 
        chat.id._serialized.includes('@newsletter') ||
        chat.id._serialized.includes('@broadcast')
      )
      .map((channel) => ({
        id: channel.id._serialized,
        name: channel.name || 'Unnamed Channel',
        description: channel.description || null,
        verified: channel.isVerified || false,
        subscribersCount: channel.participantsCount || channel.size || 0,
        type: channel.type || 'channel'
      }));

    console.log(`✅ Found ${channels.length} channel(s)`);

    return res.json({
      success: true,
      sessionId,
      total: channels.length,
      channels,
    });
  } catch (err) {
    console.error("❌ Error listing channels:", err.message);
    return res.status(500).json({
      error: "Failed to list channels",
      details: err.message,
      note: "Channels feature may not be available for all WhatsApp accounts"
    });
  }
};

/**
 * ✅ POST /wa/utility/location/send
 * Send location to a contact or group
 */
export const sendLocation = async (req, res) => {
  try {
    const { sessionId, to, latitude, longitude, name, address } = req.body;

    if (!sessionId || !to || latitude === undefined || longitude === undefined) {
      return res.status(400).json({ 
        error: "sessionId, to, latitude, and longitude required" 
      });
    }

    const client = await getOrRestoreClient(sessionId);
    if (!client || !client.info) {
      return res.status(400).json({ error: "Session not ready yet" });
    }

    console.log(`📍 Sending location (${latitude}, ${longitude}) to: ${to}`);

    // Create location object
    const location = new Location(latitude, longitude, name, address);

    // Simple recipient resolution (similar to message controller)
    let recipientId = to.trim();
    let recipientName = to;

    // If not a WhatsApp ID format, try to resolve it
    if (!to.includes('@')) {
      // Try to find as group name
      const chats = await client.getChats();
      const matchingChat = chats.find(chat => 
        (chat.isGroup && chat.name && chat.name.toLowerCase() === to.toLowerCase()) ||
        chat.id.user === to
      );
      
      if (matchingChat) {
        recipientId = matchingChat.id._serialized;
        recipientName = matchingChat.name || to;
      } else {
        // Assume it's a phone number, add @c.us
        recipientId = `${to}@c.us`;
      }
    }

    const resolved = { id: recipientId, name: recipientName };

    if (!resolved.id) {
      return res.status(404).json({
        error: `Recipient not found: ${to}`,
        hint: "Use phone number with country code or exact group name"
      });
    }

    // Send location
    const msg = await client.sendMessage(resolved.id, location);

    console.log(`✅ Location sent to ${resolved.name || to}`);

    return res.json({
      success: true,
      messageId: msg.id._serialized,
      to: resolved.id,
      recipientName: resolved.name,
      location: {
        latitude,
        longitude,
        name: name || null,
        address: address || null
      }
    });
  } catch (err) {
    console.error("❌ Error sending location:", err.message);
    return res.status(500).json({
      error: "Failed to send location",
      details: err.message,
    });
  }
};