import { getClient, getOrRestoreClient } from "../services/waManager.js";
import GroupModel from "../models/Group.js";
import pkg from "whatsapp-web.js";
const { MessageMedia } = pkg;
import mime from "mime-types";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import ffmpeg from "fluent-ffmpeg";

/**
 * ✅ GET /wa/groups
 * Get list of all groups for current session
 */

export const getAllGroups = async (req, res) => {
  const { sessionId } = req.query;
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });

  try {
    const client = await getOrRestoreClient(sessionId);
    if (!client || !client.info)
      return res.status(400).json({ error: "Session not ready yet" });
      
    const chats = await client.getChats();
    const groups = chats.filter((chat) => chat.isGroup);
    
    // Format groups for frontend
    const formattedGroups = groups.map((g) => ({
      id: g.id._serialized,
      name: g.name,
      participants: g.participants || [],
      isGroup: true,
      timestamp: g.timestamp || Date.now()
    }));
    
    // Also save to database for future reference (non-blocking)
    Promise.all(
      groups.map(async (g) => {
        try {
          await GroupModel.findOneAndUpdate(
            { groupId: g.id._serialized, sessionId },
            {
              $set: {
                subject: g.name,
                description: g.description?.body || "",
                sessionId,
                updatedAt: new Date(),
              },
            },
            { upsert: true, new: true }
          );
        } catch (err) {
          // Ignore duplicate key errors - group already exists
          if (err.code !== 11000) {
            console.error(`⚠️ Error saving group ${g.name}:`, err.message);
          }
        }
      })
    ).catch(() => {}); // Non-blocking background save
    
    res.json({ groups: formattedGroups });
  } catch (err) {
    console.error("❌ Error fetching groups:", err);
    res.status(500).json({ error: "Failed to get groups list" });
  }
};

/**
 * ✅ GET /wa/group/:groupId/participants
 * Get list of group participants
 */

export const getGroupParticipants = async (req, res) => {
  const { sessionId } = req.query;
  let { groupId } = req.params;
  
  if (!sessionId || !groupId)
    return res.status(400).json({ error: "sessionId and groupId required" });

  try {
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
      } else{
        return res.status(404).json({ 
          error: `Group not found: ${groupId}`,
          hint: "Use exact group name or group ID (e.g., '120363123456789@g.us')"
        });
      }
    }

    const chat = await client.getChatById(groupId);
    if (!chat.isGroup)
      return res.status(400).json({ error: "Not a group chat" });

    const participants = await Promise.all(
      chat.participants.map(async (p) => {
        const contact = await client.getContactById(p.id._serialized);
        return {
          waId: p.id._serialized,
          phoneNumber: contact.id.user,
          name: contact.pushname || contact.name || contact.number,
          isAdmin: p.isAdmin,
          isSuperAdmin: p.isSuperAdmin,
        };
      })
    );

    await GroupModel.findOneAndUpdate(
      { groupId },
      { 
        subject: chat.name,
        participants, 
        updatedAt: new Date() 
      },
      { upsert: true }
    );
    
    return res.json({
      success: true,
      groupId,
      groupName: chat.name,
      totalMembers: participants.length,
      participants
    });
  } catch (err) {
    console.error(`❌ Error fetching participants:`, err.message);
    return res.status(500).json({ 
      error: "Failed to get group participants",
      details: err.message 
    });
  }
};

/**
 * ✅ POST /wa/group/create
 */

export const createGroup = async (req, res) => {
  const { sessionId, subject, participants = [], description } = req.body;
  if (!sessionId || !subject)
    return res.status(400).json({ error: "sessionId and subject required" });

  if (!participants || participants.length === 0)
    return res.status(400).json({ error: "At least one participant required" });

  const client = await getOrRestoreClient(sessionId);
  if (!client || !client.info)
    return res.status(400).json({ error: "Session not ready yet" });

  try {
    // Clean and validate participants
    console.log(`📋 Received participants:`, participants);
    
    const cleanedParticipants = participants.map(p => {
      // Remove any whitespace
      let phone = p.trim();
      
      // If already has @c.us, use as is
      if (phone.includes('@c.us')) {
        return phone;
      }
      
      // Remove any + or spaces or dashes
      phone = phone.replace(/[\+\s\-]/g, '');
      
      // Add @c.us suffix
      return `${phone}@c.us`;
    });

    console.log(`✅ Cleaned participants:`, cleanedParticipants);

    // Validate all participants are registered WhatsApp users
    const validParticipants = [];
    for (const participant of cleanedParticipants) {
      try {
        const isRegistered = await client.isRegisteredUser(participant);
        if (isRegistered) {
          validParticipants.push(participant);
          console.log(`✅ Valid: ${participant}`);
        } else {
          console.log(`⚠️ Not registered: ${participant}`);
        }
      } catch (err) {
        console.log(`❌ Error checking ${participant}: ${err.message}`);
      }
    }

    if (validParticipants.length === 0) {
      return res.status(400).json({ 
        error: "No valid WhatsApp users found in participants list",
        hint: "Ensure phone numbers include country code (e.g., 919876543210)"
      });
    }

    console.log(`🚀 Creating group with ${validParticipants.length} valid participants`);

    // 1️⃣ Create WhatsApp group
    const group = await client.createGroup(subject, validParticipants);
    const groupId = group.gid._serialized;

    console.log(`✅ Created WhatsApp group: ${subject} (${groupId})`);

    // 2️⃣ Optionally set description
    if (description) {
      const chat = await client.getChatById(groupId);
      await chat.setDescription(description);
    }

    // 3️⃣ Fetch updated group info from WhatsApp
    const chat = await client.getChatById(groupId);

    // 4️⃣ Build detailed participants list
    const participantDocs = await Promise.all(
      chat.participants.map(async (p) => {
        const contact = await client.getContactById(
          p.id._serialized
        );
        return {
          waId: p.id._serialized,
          name: contact.pushname || contact.name || contact.number || "Unknown",
          isAdmin: p.isAdmin || false,
          isSuperAdmin: p.isSuperAdmin || false,
        };
      })
    );

    // 5️⃣ Save group to MongoDB
    console.log("🟢 Saving new group to DB:", {
      sessionId,
      groupId,
      subject,
      participants: participantDocs,
    });

    await GroupModel.create({
      sessionId,
      groupId,
      subject,
      description: description || "",
      participants: participantDocs,
    });

    // 6️⃣ Respond with full data
    return res.json({
      success: true,
      message: "Group created successfully",
      groupId,
      subject,
      participants: participantDocs,
    });
  } catch (err) {
    console.error("❌ Error creating group:", err);
    return res.status(500).json({ error: "Failed to create group" });
  }
};

/**
 * ✅ GET /wa/group/latestgroups
 * Returns the most recently created groups (from your MongoDB)
 */

export const getLatestGroups = async (req, res) => {
  const { sessionId } = req.query;
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });

  const client = await getOrRestoreClient(sessionId);
  if (!client || !client.info)
    return res.status(400).json({ error: "Session not ready yet" });

  try {
    const limit = parseInt(req.query.limit) || 10;

    const latestGroups = await GroupModel.find({ sessionId })
      .sort({ createdAt: -1 })
      .limit(limit);

    if (!latestGroups.length)
      return res
        .status(404)
        .json({ message: "No groups found for this session" });

    res.status(200).json(latestGroups);
  } catch (err) {
    console.error("❌ Error fetching latest groups:", err);
    res.status(500).json({ error: "Failed to fetch latest groups" });
  }
};

/**
 * ✅ POST /wa/group/:groupId/add
 */
export const addGroupParticipant = async (req, res) => {
  const { sessionId, waId } = req.body;
  const { groupId } = req.params;

  if (!sessionId || !groupId || !waId)
    return res.status(400).json({ error: "sessionId, groupId, waId required" });

  const client = await getOrRestoreClient(sessionId);
  if (!client || !client.info)
    return res.status(400).json({ error: "Session not ready yet" });

  try {
    const chat = await client.getChatById(groupId);
    await chat.addParticipants([waId]);

    await GroupModel.updateOne(
      { groupId },
      { $addToSet: { participants: { waId } } }
    );

    res.json({ status: "added" });
  } catch (err) {
    console.error("Error adding participant:", err);
    res.status(500).json({ error: "Failed to add participant" });
  }
};

/**
 * ✅ POST /wa/group/:groupId/remove
 */
export const removeGroupParticipant = async (req, res) => {
  const { sessionId, waId } = req.body;
  const { groupId } = req.params;

  if (!sessionId || !groupId || !waId)
    return res.status(400).json({ error: "sessionId, groupId, waId required" });

  const client = await getOrRestoreClient(sessionId);
  if (!client || !client.info)
    return res.status(400).json({ error: "Session not ready yet" });

  try {
    const chat = await client.getChatById(groupId);
    await chat.removeParticipants([waId]);

    await GroupModel.updateOne(
      { groupId },
      { $pull: { participants: { waId } } }
    );

    res.json({ status: "removed" });
  } catch (err) {
    console.error("Error removing participant:", err);
    res.status(500).json({ error: "Failed to remove participant" });
  }
};

/**
 * ✅ POST /wa/group/:groupId/promote
 */
export const promoteGroupAdmin = async (req, res) => {
  const { sessionId, waId } = req.body;
  const { groupId } = req.params;
  const client = await getOrRestoreClient(sessionId);

  if (!client || !client.info)
    return res.status(400).json({ error: "Session not ready yet" });

  try {
    const chat = await client.getChatById(groupId);
    await chat.promoteParticipants([waId]);

    await GroupModel.updateOne(
      { groupId, "participants.waId": waId },
      { $set: { "participants.$.isAdmin": true } }
    );

    res.json({ status: "promoted" });
  } catch (err) {
    console.error("Error promoting participant:", err);
    res.status(500).json({ error: "Failed to promote participant" });
  }
};

/**
 * ✅ POST /wa/group/:groupId/demote
 */
export const demoteGroupAdmin = async (req, res) => {
  const { sessionId, waId } = req.body;
  const { groupId } = req.params;
  const client = await getOrRestoreClient(sessionId);

  if (!client || !client.info)
    return res.status(400).json({ error: "Session not ready yet" });

  try {
    const chat = await client.getChatById(groupId);
    await chat.demoteParticipants([waId]);

    await GroupModel.updateOne(
      { groupId, "participants.waId": waId },
      { $set: { "participants.$.isAdmin": false } }
    );

    res.json({ status: "demoted" });
  } catch (err) {
    console.error("Error demoting participant:", err);
    res.status(500).json({ error: "Failed to demote participant" });
  }
};

/**
 * ✅ POST /wa/group/:groupId/update-info
 */
export const updateGroupInfo = async (req, res) => {
  const { sessionId, subject, description } = req.body;
  const { groupId } = req.params;
  const client = await getOrRestoreClient(sessionId);

  if (!client || !client.info)
    return res.status(400).json({ error: "Session not ready yet" });

  try {
    const chat = await client.getChatById(groupId);
    if (subject) await chat.setSubject(subject);
    if (description) await chat.setDescription(description);

    await GroupModel.findOneAndUpdate(
      { groupId },
      { subject, description, updatedAt: new Date() }
    );

    res.json({ status: "updated" });
  } catch (err) {
    console.error("Error updating group info:", err);
    res.status(500).json({ error: "Failed to update group info" });
  }
};

/**
 * ✅ POST /wa/group/:groupId/settings
 */
export const updateGroupSettings = async (req, res) => {
  const { sessionId, restrictions } = req.body;
  const { groupId } = req.params;
  const client = await getOrRestoreClient(sessionId);

  if (!client || !client.info)
    return res.status(400).json({ error: "Session not ready yet" });

  try {
    const chat = await client.getChatById(groupId);
    await GroupModel.findOneAndUpdate(
      { groupId },
      { settings: restrictions, updatedAt: new Date() }
    );

    res.json({ status: "updated" });
  } catch (err) {
    console.error("Error updating group settings:", err);
    res.status(500).json({ error: "Failed to update group settings" });
  }
};

/**
 * ✅ GET /wa/group/invite/:inviteCode
 */
export const getInviteInfo = async (req, res) => {
  const { sessionId } = req.query;
  const { inviteCode } = req.params;
  const client = await getOrRestoreClient(sessionId);

  if (!client || !client.info)
    return res.status(400).json({ error: "Session not ready yet" });

  try {
    const info = await client.getInviteInfo(inviteCode);
    res.json(info);
  } catch (err) {
    console.error("Error getting invite info:", err);
    res.status(500).json({ error: "Failed to get invite info" });
  }
};

/**
 * ✅ POST /wa/group/join-by-invite
 */
export const joinGroupByInvite = async (req, res) => {
  const { sessionId, inviteLink } = req.body;
  const client = await getOrRestoreClient(sessionId);

  if (!client || !client.info)
    return res.status(400).json({ error: "Session not ready yet" });

  try {
    const result = await client.acceptInvite(
      inviteLink.split("/").pop()
    );
    res.json({ status: "joined", groupId: result });
  } catch (err) {
    console.error("Error joining group:", err);
    res.status(500).json({ error: "Failed to join group" });
  }
};

/**
 * ✅ POST /wa/group/:groupId/mention
 */

export const mentionInGroup = async (req, res) => {
  const { sessionId, message, mentions } = req.body;
  const { groupId } = req.params;

  const client = await getOrRestoreClient(sessionId);
  if (!client || !client.info)
    return res.status(400).json({ error: "Session not ready yet" });

  if (!Array.isArray(mentions) || mentions.length === 0) {
    return res
      .status(400)
      .json({ error: "mentions must be a non-empty array" });
  }

  try {
    const chat = await client.getChatById(groupId);

    // Fetch contacts from waId list
    const contacts = await Promise.all(
      mentions.map(async (id) => {
        const c = await client.getContactById(id);
        return c;
      })
    );

    // Construct a message with real mentions (optional enhancement)
    const mentionNames = contacts
      .map((c) => `@${c.pushname || c.number}`)
      .join(" ");
    const fullMessage = `${message}\n${mentionNames}`;

    await chat.sendMessage(fullMessage, { mentions: contacts });

    res.json({ status: "sent", mentions: mentions.length });
  } catch (err) {
    console.error("Error mentioning participants:", err);
    res.status(500).json({ error: "Failed to mention participants" });
  }
};

// **
//  * ✅ POST /wa/group/:groupId/message
//  * Send text message to a group
//  */

export const sendGroupMessage = async (req, res) => {
  const { sessionId, text } = req.body;
  const { groupId } = req.params;

  if (!sessionId || !groupId || !text)
    return res
      .status(400)
      .json({ error: "sessionId, groupId, and text are required" });

  const client = await getOrRestoreClient(sessionId);
  if (!client || !client.info)
    return res.status(400).json({ error: "Session not ready yet" });

  try {
    console.log(`📨 Sending message to group ${groupId}...`);
    const msg = await client.sendMessage(groupId, text);

    res.json({
      success: true,
      messageId: msg.id._serialized,
      groupId,
      text,
    });

    console.log(`✅ Message sent to group ${groupId}`);
  } catch (err) {
    console.error("❌ Error sending group message:", err);
    res.status(500).json({ error: "Failed to send group message" });
  }
};

/**
 * ✅ POST /wa/group/:groupId/send-media
 * Send media (image/video/document) to a group
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const safeUnlink = (filePath) => {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    console.error("Cleanup failed:", err);
  }
};

// Convert any video into WhatsApp compatible MP4
const convertToMp4 = (inputPath, outputPath) => {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions([
        "-c:v libx264", // H.264 codec
        "-c:a aac", // AAC audio
        "-movflags +faststart",
      ])
      .on("end", () => resolve(outputPath))
      .on("error", (err) => reject(err))
      .save(outputPath);
  });
};

export const sendGroupMedia = async (req, res) => {
  try {
    const { sessionId, caption } = req.body;
    const { groupId } = req.params;

    if (!sessionId || !groupId)
      return res.status(400).json({ error: "sessionId and groupId required" });

    const client = await getOrRestoreClient(sessionId);
    if (!client || !client.info)
      return res.status(400).json({ error: "Session not ready yet" });

    const file = req.file || (req.files && req.files[0]);
    if (!file) return res.status(400).json({ error: "No media file uploaded" });

    const filePath = path.resolve(file.path);
    const ext = path.extname(file.originalname).toLowerCase();
    let mimeType = mime.lookup(file.originalname) || file.mimetype;
    let finalPath = filePath;

    // --- WhatsApp limit 16MB ---
    const sizeMB = file.size / (1024 * 1024);
    if (sizeMB > 16) {
      safeUnlink(filePath);
      return res.status(400).json({ error: "File too large (>16MB)" });
    }

    // --- Video Conversion if needed ---
    if (mimeType.startsWith("video/")) {
      if (ext !== ".mp4" || mimeType !== "video/mp4") {
        const convertedPath = path.join(
          __dirname,
          `converted-${Date.now()}.mp4`
        );
        console.log(`🔄 Converting ${file.originalname} to WhatsApp MP4...`);
        await convertToMp4(filePath, convertedPath);
        finalPath = convertedPath;
        mimeType = "video/mp4";
      }
    }

    // --- Use safer loader ---
    const media = MessageMedia.fromFilePath(finalPath);

    // --- Delivery options ---
    const options = { caption: caption || "" };

    if (mimeType.startsWith("image/")) {
      options.sendMediaAsDocument = false;
    } else if (mimeType.startsWith("video/")) {
      options.sendMediaAsDocument = false; // send as playable video
    } else if (mimeType.startsWith("audio/")) {
      options.ptt = true; // voice note
      options.sendMediaAsDocument = false;
    } else {
      options.sendMediaAsDocument = true; // docs only
    }

    console.log(`📤 Sending ${mimeType} to group ${groupId}`);

    const msg = await client.sendMessage(groupId, media, options);

    // cleanup
    safeUnlink(filePath);
    if (finalPath !== filePath) safeUnlink(finalPath);

    res.json({
      success: true,
      type: mimeType,
      messageId: msg.id._serialized,
      groupId,
    });
    console.log(`✅ Media sent to group ${groupId}`);
  } catch (err) {
    console.error("❌ Error sending media:", err);
    res.status(500).json({
      error: "Failed to send media",
      details: err.message,
    });
  }
};

// get group id by name



export const getGroupIdByName = async (req, res) => {
  try {
    const { sessionId, groupName } = req.query;

    if (!sessionId || !groupName) {
      return res
        .status(400)
        .json({ error: "sessionId and groupName required" });
    }

    const client = await getOrRestoreClient(sessionId);
    if (!client || !client.info) {
      return res.status(400).json({ error: "Session not ready yet" });
    }

    console.log(`🔍 Searching for group: "${groupName}"`);

    // safe normalize helper
    const normalize = (str) =>
      (str ? String(str) : "")
        .normalize("NFKC")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();

    // Get all chats
    const chats = await client.getChats();

    // exact match first
    let group = chats.find(
      (c) => c.isGroup && c.name && normalize(c.name) === normalize(groupName)
    );

    // fallback: partial match
    if (!group) {
      const matches = chats.filter(
        (c) => c.isGroup && c.name && normalize(c.name).includes(normalize(groupName))
      );

      if (matches.length === 1) {
        group = matches[0];
      } else if (matches.length > 1) {
        return res.json({
          message: "Multiple groups matched, please refine your search",
          matches: matches.map((g) => ({
            groupId: g.id._serialized,
            name: g.name,
            participantsCount: g.participants?.length || 0,
          })),
        });
      }
    }

    if (!group) {
      return res.status(404).json({ 
        error: "Group not found",
        searchedFor: groupName,
        hint: "Use exact group name or check available groups with /api/wa/message/debug-groups"
      });
    }

    return res.json({
      success: true,
      groupId: group.id._serialized,
      name: group.name,
      participantsCount: group.participants?.length || 0,
    });
  } catch (err) {
    console.error("❌ Error getting groupId:", err.message);
    return res.status(500).json({ 
      error: "Failed to get groupId",
      details: err.message 
    });
  }
};

