// routes/webhook.route.js
import express from "express";
import * as webhookCtrl from "../controllers/webhook.controller.js";

const router = express.Router();

// Webhook management
router.post("/register", webhookCtrl.register);
router.post("/unregister", webhookCtrl.unregister);
router.get("/list", webhookCtrl.getWebhooks);
router.post("/test", webhookCtrl.testWebhook);

export default router;

