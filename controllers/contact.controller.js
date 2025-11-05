
import { getClient, getOrRestoreClient } from "../services/waManager.js";
import contactModel from "../models/contact.js";

/**
 * POST /wa/contact/check
 * Check if a number has WhatsApp and save/update in DB
 */
export const checkContact = async (req, res) => {
  const { sessionId, number } = req.body;
  if (!sessionId || !number)
    return res.status(400).json({ error: "sessionId and number required" });

  try {
    const client = await getOrRestoreClient(sessionId);
    if (!client || !client.info)
      return res.status(400).json({ error: "Session not ready yet" });

    // Clean the number (remove spaces, dashes, plus signs)
    const cleanNumber = number.replace(/[\s\-\+]/g, '');
    const waId = `${cleanNumber}@c.us`;
    
    console.log(`🔍 Checking contact: ${number} → ${waId}`);
    
    let isRegistered;
    try {
      isRegistered = await client.isRegisteredUser(waId);
    } catch (checkErr) {
      console.error(`❌ Error checking registration for ${waId}:`, checkErr.message);
      // If the check fails, try to get the contact to see if it exists
      try {
        await client.getNumberId(waId);
        isRegistered = true;
      } catch {
        isRegistered = false;
      }
    }

    if (!isRegistered) {
      console.log(`❌ Number not registered: ${number}`);
      return res.json({
        number,
        waId,
        hasWhatsapp: false,
        message: "Number not on WhatsApp",
      });
    }

    console.log(`✅ Number is registered: ${number}`);
    
    // Save to DB
    await contactModel.findOneAndUpdate(
      { waId, userId: sessionId },
      {
        isRegistered: true,
        updatedAt: new Date(),
      },
      { upsert: true, new: true }
    );

    // ✅ Return simple check result
    return res.json({
      number: cleanNumber,
      waId,
      hasWhatsapp: true,
      message: "Number is on WhatsApp",
    });
  } catch (err) {
    console.error("Error checking contact:", err);
    return res.status(500).json({ error: "Failed to check contact", details: err.message });
  }
};

/**
 * GET /wa/contact/info?sessionId=&waId=
 * Get WhatsApp contact info (name, status, etc.)
 */
export const getContactInfo = async (req, res) => {
  const { sessionId, waId } = req.query;
  if (!sessionId || !waId)
    return res.status(400).json({ error: "sessionId and waId required" });

  try {
    const client = await getOrRestoreClient(sessionId);
    if (!client || !client.info)
      return res.status(400).json({ error: "Session not ready yet" });

    const contact = await client.getContactById(waId);

    // ✅ Get about/status
    let about = null;
    try {
      about = await contact.getAbout();
    } catch {
      about = "No status available";
    }

    // ✅ Get profile picture
    let profilePicUrl = null;
    try {
      profilePicUrl = await contact.getProfilePicUrl();
    } catch {
      profilePicUrl = null;
    }

    // ✅ Check if blocked
    const blockedContacts = await client.getBlockedContacts();
    const isBlocked = blockedContacts.some(
      (c) => c.id._serialized === waId
    );

    // ✅ (Optional) Last seen – only available for some versions/users
    let lastSeen = null;
    try {
      lastSeen = contact.lastSeen ? contact.lastSeen.toString() : null;
    } catch {
      lastSeen = null;
    }

    return res.json({
      waId,
      name: contact.name || contact.pushname || "Unknown",
      status: about,
      profilePicUrl,
      isBlocked,
      lastSeen,
    });
  } catch (err) {
    console.error("Error getting contact info:", err);
    return res.status(500).json({ error: "Failed to get contact info" });
  }
};


/**
 * POST /wa/contact/block
 * Body: { sessionId, waId }
 */
export const blockContact = async (req, res) => {
  const { sessionId, waId } = req.body;
  if (!sessionId || !waId)
    return res.status(400).json({ error: "sessionId and waId required" });

  try {
    const client = await getOrRestoreClient(sessionId);
    if (!client || !client.info)
      return res.status(400).json({ error: "Session not ready yet" });

    const contact = await client.getContactById(waId);
    await contact.block();

    await contactModel.findOneAndUpdate(
      { waId },
      { isBlocked: true, updatedAt: new Date() }
    );

    return res.json({ waId, status: "blocked" });
  } catch (err) {
    console.error("Error blocking contact:", err);
    return res.status(500).json({ error: "Failed to block contact" });
  }
};


/**
 * POST /wa/contact/unblock
 * Body: { sessionId, waId }
 */
export const unblockContact = async (req, res) => {
  const { sessionId, waId } = req.body;
  if (!sessionId || !waId)
    return res.status(400).json({ error: "sessionId and waId required" });

  try {
    const client = await getOrRestoreClient(sessionId);
    if (!client || !client.info)
      return res.status(400).json({ error: "Session not ready yet" });

    const contact = await client.getContactById(waId);
    await contact.unblock();

    await contactModel.findOneAndUpdate(
      { waId },
      { isBlocked: false, updatedAt: new Date() }
    );

    return res.json({ waId, status: "unblocked" });
  } catch (err) {
    console.error("Error unblocking contact:", err);
    return res.status(500).json({ error: "Failed to unblock contact" });
  }
};
