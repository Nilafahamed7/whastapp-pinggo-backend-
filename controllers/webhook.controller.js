// controllers/webhook.controller.js
import {
  registerWebhook,
  unregisterWebhook,
  getRegisteredWebhooks,
} from "../services/webhookManager.js";

/* ---------------------------------------------------
   Register a Webhook
--------------------------------------------------- */
export const register = async (req, res) => {
  try {
    const { eventType, url } = req.body;

    if (!eventType || !url) {
      return res.status(400).json({
        error: "eventType and url are required",
        supportedEvents: ["message", "delivery", "group", "session"],
      });
    }

    registerWebhook(eventType, url);

    return res.json({
      success: true,
      message: `Webhook registered for ${eventType}`,
      eventType,
      url,
    });
  } catch (err) {
    console.error("Error registering webhook:", err.message);
    return res.status(500).json({
      error: "Failed to register webhook",
      details: err.message,
    });
  }
};

/* ---------------------------------------------------
   Unregister a Webhook
--------------------------------------------------- */
export const unregister = async (req, res) => {
  try {
    const { eventType } = req.body;

    if (!eventType) {
      return res.status(400).json({ error: "eventType is required" });
    }

    unregisterWebhook(eventType);

    return res.json({
      success: true,
      message: `Webhook unregistered for ${eventType}`,
      eventType,
    });
  } catch (err) {
    console.error("Error unregistering webhook:", err.message);
    return res.status(500).json({
      error: "Failed to unregister webhook",
      details: err.message,
    });
  }
};

/* ---------------------------------------------------
   Get All Registered Webhooks
--------------------------------------------------- */
export const getWebhooks = async (req, res) => {
  try {
    const webhooks = getRegisteredWebhooks();

    return res.json({
      success: true,
      webhooks,
      supportedEvents: {
        message: "Triggered when a message is received",
        delivery: "Triggered when a message is delivered/read",
        group: "Triggered when group members are added/removed",
        session: "Triggered when session status changes",
      },
    });
  } catch (err) {
    console.error("Error getting webhooks:", err.message);
    return res.status(500).json({
      error: "Failed to get webhooks",
      details: err.message,
    });
  }
};

/* ---------------------------------------------------
   Test Webhook (sends a test payload)
--------------------------------------------------- */
export const testWebhook = async (req, res) => {
  try {
    const { eventType, url } = req.body;

    if (!eventType || !url) {
      return res.status(400).json({
        error: "eventType and url are required",
      });
    }

    const testPayloads = {
      message: {
        event: "message.received",
        messageId: "TEST_MESSAGE_ID",
        from: "1234567890@c.us",
        to: "test_session",
        text: "This is a test message",
        type: "chat",
        timestamp: Date.now(),
        sessionId: "test_session_id",
      },
      delivery: {
        event: "message.delivered",
        messageId: "TEST_MESSAGE_ID",
        status: "delivered",
        timestamp: new Date().toISOString(),
        sessionId: "test_session_id",
      },
      group: {
        event: "group.member.added",
        groupId: "120363123456789@g.us",
        groupName: "Test Group",
        waId: "1234567890@c.us",
        addedBy: "9876543210@c.us",
        timestamp: new Date().toISOString(),
        sessionId: "test_session_id",
      },
      session: {
        event: "session.update",
        sessionId: "test_session_id",
        status: "connected",
        phoneNumber: "1234567890",
        timestamp: new Date().toISOString(),
      },
    };

    const payload = testPayloads[eventType];
    if (!payload) {
      return res.status(400).json({
        error: "Invalid eventType",
        supportedEvents: Object.keys(testPayloads),
      });
    }

    const axios = (await import("axios")).default;
    await axios.post(url, payload, {
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Event": eventType,
        "X-Webhook-Test": "true",
      },
      timeout: 5000,
    });

    console.log(`✅ Test webhook sent to ${url}`);

    return res.json({
      success: true,
      message: "Test webhook sent successfully",
      eventType,
      url,
      payload,
    });
  } catch (err) {
    console.error("Error testing webhook:", err.message);
    return res.status(500).json({
      error: "Failed to send test webhook",
      details: err.message,
    });
  }
};

