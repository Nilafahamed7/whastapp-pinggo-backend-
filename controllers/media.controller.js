import fs from "fs";
import path from "path";
import mime from "mime-types";
import pkg from "whatsapp-web.js";
import axios from "axios";
const { MessageMedia, Location } = pkg;
import { getClient, getOrRestoreClient } from "../services/waManager.js";

// === Helper Functions ===

const safeUnlink = (filePath) => {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    console.error("Cleanup failed:", err);
  }
};

const fileToBase64 = (filePath) => {
  const buffer = fs.readFileSync(filePath);
  return buffer.toString("base64");
};

// Resolve recipient (group name, ID, or phone number)
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
        name: matchingChat.name
      };
    }
  } catch (err) {
    console.error(`⚠️ Error searching for group "${recipient}":`, err.message);
  }
  
  // If not found, return null
  return { id: null, name: null };
};

// ======================= MEDIA (image/audio/doc) =======================
export const sendMedia = async (req, res) => {
  const { sessionId, to, mediaUrl, type, caption } = req.body;
  
  try {
    if (!sessionId || !to)
      return res.status(400).json({ error: "sessionId and to are required" });

    const client = await getOrRestoreClient(sessionId);
    if (!client.info) {
      return res.status(400).json({ error: "Session not ready yet" });
    }

    // Resolve recipient (supports group names, IDs, or phone numbers)
    const resolved = await resolveRecipient(client, to);
    if (!resolved.id) {
      return res.status(400).json({ error: `Recipient not found: ${to}` });
    }
    const chatId = resolved.id;

    let media;

    // File upload
    if (req.file) {
      const filePath = path.resolve(req.file.path);
      const mimeType = mime.lookup(req.file.originalname) || "application/octet-stream";
      const base64 = fileToBase64(filePath);
      media = new MessageMedia(mimeType, base64, req.file.originalname);
      safeUnlink(filePath);
    }
    // File URL
    else if (mediaUrl) {
      media = await MessageMedia.fromUrl(mediaUrl);
    } else {
      return res.status(400).json({ error: "No media file or URL provided" });
    }

    const sendOptions = { caption };

    if (type === "audio") sendOptions.ptt = true;
    if (type === "document") sendOptions.sendMediaAsDocument = true;
    if (type === "image") sendOptions.sendMediaAsDocument = false;

    console.log(`📤 Sending ${media.mimetype} to ${chatId} via ${sessionId}`);

    const msg = await client.sendMessage(chatId, media, sendOptions);

    console.log(`✅ Media sent successfully`);
    return res.json({
      success: true,
      chatId,
      sessionId,
      type,
      messageId: msg.id._serialized,
    });
  } catch (err) {
    console.error(`❌ Error sending media via ${sessionId}:`, err.message);
    return res.status(500).json({ error: "Failed to send media", details: err.message });
  }
};

// ======================= VIDEO =======================
export const sendVideo = async (req, res) => {
  const { sessionId, to, mediaUrl, caption } = req.body;
  
  try {
    if (!sessionId || !to)
      return res.status(400).json({ error: "sessionId and to are required" });

    const client = await getOrRestoreClient(sessionId);
    
    if (!client.info) {
      return res.status(400).json({ error: "Session not ready yet" });
    }

    // Resolve recipient (supports group names, IDs, or phone numbers)
    const resolved = await resolveRecipient(client, to);
    if (!resolved.id) {
      return res.status(400).json({ error: `Recipient not found: ${to}` });
    }
    const chatId = resolved.id;

    let media;

    if (req.file) {
      const filePath = path.resolve(req.file.path);
      const mimeType = mime.lookup(req.file.originalname) || "video/mp4";
      const base64 = fileToBase64(filePath);
      media = new MessageMedia(mimeType, base64, req.file.originalname);
      safeUnlink(filePath);
    } else if (mediaUrl) {
      media = await MessageMedia.fromUrl(mediaUrl, { unsafeMime: true });
    } else {
      return res.status(400).json({ error: "No video provided" });
    }

    const options = {
      caption: caption || "",
      sendVideoAsDocument: false,
      sendMediaAsDocument: false,
    };

    // Try different methods silently
    let msg;
    
    try {
      msg = await client.sendMessage(chatId, media, options);
    } catch (err1) {
      try {
        const docOptions = { caption: caption || "", sendMediaAsDocument: true };
        msg = await client.sendMessage(chatId, media, docOptions);
      } catch (err2) {
        const chat = await client.getChatById(chatId);
        msg = await chat.sendMessage(media, { caption: caption || "" });
      }
    }

    return res.json({
      success: true,
      chatId,
      sessionId,
      messageId: msg.id._serialized,
      type: "video",
      filename: media.filename
    });

  } catch (err) {
    console.error(`❌ Error sending video via ${sessionId || 'unknown'}:`, err.message);
    
    // Clean up file if it exists
    if (req.file) {
      safeUnlink(path.resolve(req.file.path));
    }
    
    return res.status(500).json({ 
      error: "Failed to send video", 
      details: err.message,
      hint: "Make sure the session is fully connected and the recipient exists"
    });
  }
};

// ======================= STICKER =======================
export const sendSticker = async (req, res) => {
  const { sessionId, to, stickerUrl } = req.body;
  
  try {
    const chatId = resolveChatId(to);

    const client = await getOrRestoreClient(sessionId);
    if (!client.info) return res.status(400).json({ error: "Session not ready yet" });

    const media = await MessageMedia.fromUrl(stickerUrl);
    const msg = await client.sendMessage(chatId, media, { sendMediaAsSticker: true });

    return res.json({ success: true, chatId, sessionId, messageId: msg.id._serialized });
  } catch (err) {
    console.error(`❌ Error sending sticker via ${sessionId}:`, err.message);
    return res.status(500).json({ error: "Failed to send sticker", details: err.message });
  }
};

// ======================= VCARD =======================
export const sendVcard = async (req, res) => {
  const { sessionId, to, vcard } = req.body;
  
  try {
    const chatId = resolveChatId(to);

    const client = await getOrRestoreClient(sessionId);
    if (!client.info) return res.status(400).json({ error: "Session not ready yet" });

    const msg = await client.sendMessage(chatId, vcard);
    return res.json({ success: true, chatId, sessionId, messageId: msg.id._serialized });
  } catch (err) {
    console.error(`❌ Error sending vcard via ${sessionId}:`, err.message);
    return res.status(500).json({ error: "Failed to send vcard", details: err.message });
  }
};

// ======================= LOCATION =======================
export const sendLocation = async (req, res) => {
  const { sessionId, to, latitude, longitude, address } = req.body;
  
  try {
    const chatId = resolveChatId(to);

    const client = await getOrRestoreClient(sessionId);
    if (!client.info) return res.status(400).json({ error: "Session not ready yet" });

    const location = new Location(latitude, longitude, address);
    const msg = await client.sendMessage(chatId, location);

    return res.json({ success: true, chatId, sessionId, messageId: msg.id._serialized });
  } catch (err) {
    console.error(`❌ Error sending location via ${sessionId}:`, err.message);
    return res.status(500).json({ error: "Failed to send location", details: err.message });
  }
};

// ======================= MULTIPLE MEDIA SEND =======================
export const sendMultipleMedia = async (req, res) => {
  const { sessionId, to, caption, mediaUrls } = req.body;
  let chatId;
  
  try {
    if (!sessionId || !to)
      return res.status(400).json({ error: "sessionId and to are required" });

    const client = await getOrRestoreClient(sessionId);
    
    // Resolve recipient (supports group names, IDs, or phone numbers)
    const resolved = await resolveRecipient(client, to);
    chatId = resolved.id;
    
    if (!chatId) {
      return res.status(400).json({ error: `Could not resolve recipient: ${to}` });
    }
    if (!client.info)
      return res.status(400).json({ error: "Session not ready yet" });

    const results = [];

    // --- Uploaded files ---
    if (req.files?.length) {
      for (const file of req.files) {
        const filePath = path.resolve(file.path);
        const mimeType = mime.lookup(file.originalname) || "application/octet-stream";
        const media = new MessageMedia(mimeType, fs.readFileSync(filePath).toString("base64"), file.originalname);

        const sendOptions = {};
        if (caption && results.length === 0) sendOptions.caption = caption;
        if (mimeType.startsWith("audio")) sendOptions.ptt = true;
        if (mimeType.startsWith("video")) {
          sendOptions.sendVideoAsDocument = false;
          sendOptions.sendMediaAsDocument = false;
        }

        try {
          const msg = await client.sendMessage(chatId, media, sendOptions);
          results.push({ source: "file", file: file.originalname, type: mimeType, messageId: msg.id._serialized });
        } catch (err) {
          safeUnlink(filePath);
          return res.status(500).json({ error: `Failed to send file ${file.originalname}`, details: err.message });
        }

        safeUnlink(filePath);
      }

      return res.json({ success: true, chatId, count: results.length, results });
    }

    // --- Remote URLs ---
    if (mediaUrls) {
      let urls = Array.isArray(mediaUrls) ? mediaUrls : [mediaUrls];

      for (const url of urls) {
        let media;
        try {
          const response = await axios.get(url, { responseType: "arraybuffer" });
          const buffer = Buffer.from(response.data, "binary");
          const ext = path.extname(url.split("?")[0]) || "";
          const mimeType = mime.lookup(ext) || response.headers["content-type"] || "application/octet-stream";
          const filename = path.basename(url.split("?")[0]) || `file${ext}`;

          media = new MessageMedia(mimeType, buffer.toString("base64"), filename);
        } catch (err) {
          return res.status(400).json({ error: `Could not fetch URL ${url}`, details: err.message });
        }

        const sendOptions = {};
        if (caption && results.length === 0) sendOptions.caption = caption;
        if (media.mimetype?.startsWith("audio")) sendOptions.ptt = true;
        if (media.mimetype?.startsWith("video")) {
          sendOptions.sendVideoAsDocument = false;
          sendOptions.sendMediaAsDocument = false;
        }

        try {
          const msg = await client.sendMessage(chatId, media, sendOptions);
          results.push({ source: "url", url, type: media.mimetype, messageId: msg.id._serialized });
        } catch (err) {
          return res.status(500).json({ error: `Failed to send media from URL ${url}`, details: err.message });
        }
      }

      return res.json({ success: true, chatId, count: results.length, results });
    }

    return res.status(400).json({ error: "No media files or URLs provided" });
  } catch (err) {
    return res.status(500).json({ error: "Failed to send multiple media", details: err.message });
  }
};