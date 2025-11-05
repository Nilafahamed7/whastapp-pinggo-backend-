import express from "express";
import multer from "multer";
import * as msgCtrl from "../controllers/message.controller.js";

const router = express.Router();

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname),
});

const upload = multer({ storage });

router.post("/send", msgCtrl.sendMessage);
router.post("/send-batch", upload.array("files", 10), msgCtrl.sendBatchMessage);
router.post(
  "/send-batch-excel",
  upload.fields([
    { name: "excel", maxCount: 1 },
    { name: "media", maxCount: 1 },
  ]),
  msgCtrl.sendBatchFromExcel
);
router.post(
  "/send-batch-to-group",
  upload.fields([
    { name: "media", maxCount: 1 },
    { name: "files", maxCount: 10 },
  ]),
  msgCtrl.sendBatchToGroupMembers
);
router.post(
  "/send-batch-to-multiple-groups",
  upload.fields([
    { name: "media", maxCount: 1 },
    { name: "files", maxCount: 10 },
  ]),
  msgCtrl.sendBatchToMultipleGroups
);
router.post("/reply", msgCtrl.replyMessage);
router.post("/react", msgCtrl.reactToMessage);
router.get("/debug", msgCtrl.debugGroups);

export default router;
