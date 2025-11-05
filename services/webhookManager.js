// services/webhookManager.js
import axios from "axios";

// Store webhook URLs (in production, store in DB or config)
const webhookUrls = {
  message: process.env.WEBHOOK_MESSAGE_URL || null,
  delivery: process.env.WEBHOOK_DELIVERY_URL || null,
  group: process.env.WEBHOOK_GROUP_URL || null,
  session: process.env.WEBHOOK_SESSION_URL || null,
};

// Registered webhook endpoints
const registeredWebhooks = new Map();

/* -----------------------------------------------------
   Register a webhook URL
----------------------------------------------------- */
export function registerWebhook(eventType, url) {
  if (!eventType || !url) {
    throw new Error("eventType and url are required");
  }
  
  registeredWebhooks.set(eventType, url);
  console.log(`🔔 Webhook registered: ${eventType} → ${url}`);
}

/* -----------------------------------------------------
   Unregister a webhook
----------------------------------------------------- */
export function unregisterWebhook(eventType) {
  registeredWebhooks.delete(eventType);
  console.log(`🔕 Webhook unregistered: ${eventType}`);
}

/* -----------------------------------------------------
   Get all registered webhooks
----------------------------------------------------- */
export function getRegisteredWebhooks() {
  const webhooks = {};
  for (const [eventType, url] of registeredWebhooks.entries()) {
    webhooks[eventType] = url;
  }
  return webhooks;
}

/* -----------------------------------------------------
   Send webhook notification
----------------------------------------------------- */
async function sendWebhook(eventType, payload) {
  // Check registered webhooks first
  let url = registeredWebhooks.get(eventType);
  
  // Fallback to environment variables
  if (!url) {
    url = webhookUrls[eventType];
  }
  
  if (!url) {
    // No webhook configured for this event type
    return;
  }

  try {
    await axios.post(url, payload, {
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Event": eventType,
      },
      timeout: 5000, // 5 second timeout
    });
    
    console.log(`✅ Webhook sent: ${eventType} → ${url}`);
  } catch (err) {
    console.error(`❌ Webhook failed for ${eventType}:`, err.message);
  }
}

/* -----------------------------------------------------
   Webhook Event Senders
----------------------------------------------------- */

export async function notifyMessageReceived(data) {
  await sendWebhook("message", {
    event: "message.received",
    messageId: data.messageId,
    from: data.from,
    to: data.to,
    text: data.text,
    type: data.type,
    timestamp: data.timestamp,
    sessionId: data.sessionId,
  });
}

export async function notifyMessageDelivered(data) {
  await sendWebhook("delivery", {
    event: "message.delivered",
    messageId: data.messageId,
    status: data.status,
    timestamp: data.timestamp,
    sessionId: data.sessionId,
  });
}

export async function notifyGroupMemberAdded(data) {
  await sendWebhook("group", {
    event: "group.member.added",
    groupId: data.groupId,
    groupName: data.groupName,
    waId: data.waId,
    addedBy: data.addedBy,
    timestamp: data.timestamp,
    sessionId: data.sessionId,
  });
}

export async function notifyGroupMemberRemoved(data) {
  await sendWebhook("group", {
    event: "group.member.removed",
    groupId: data.groupId,
    groupName: data.groupName,
    waId: data.waId,
    removedBy: data.removedBy,
    timestamp: data.timestamp,
    sessionId: data.sessionId,
  });
}

export async function notifySessionUpdate(data) {
  await sendWebhook("session", {
    event: "session.update",
    sessionId: data.sessionId,
    status: data.status,
    phoneNumber: data.phoneNumber,
    timestamp: data.timestamp,
  });
}

export async function notifyMessageAck(data) {
  await sendWebhook("delivery", {
    event: "message.ack",
    messageId: data.messageId,
    ack: data.ack,
    ackName: data.ackName,
    timestamp: data.timestamp,
    sessionId: data.sessionId,
  });
}

