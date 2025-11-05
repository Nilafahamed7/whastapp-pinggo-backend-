import express from "express";
import multer from "multer";
import * as mediaCtrl from "../controllers/media.controller.js";

const router = express.Router();

// 🗂️ Storage setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname),
});

const upload = multer({ storage });

// 🎯 Routes
router.post("/send", upload.single("file"), mediaCtrl.sendMedia);
router.post("/send-video", upload.single("file"), mediaCtrl.sendVideo);
router.post("/send-sticker", mediaCtrl.sendSticker);
router.post("/send-vcard", mediaCtrl.sendVcard);
router.post("/send-location", mediaCtrl.sendLocation);
router.post("/send-multiple", upload.array("files", 10), mediaCtrl.sendMultipleMedia); // ✅ fixed line

export default router;
