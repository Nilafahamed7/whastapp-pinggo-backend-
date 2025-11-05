import express from "express";
import * as groupCtrl from "../controllers/group.controller.js";
import multer from 'multer';

const router = express.Router();

// Save uploaded files to uploads/ folder
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname),
});
const upload = multer({ storage });

router.get("/grouplist", groupCtrl.getAllGroups)
router.get("/:groupId/participants", groupCtrl.getGroupParticipants);
router.post("/create", groupCtrl.createGroup);
router.get("/latestgroups", groupCtrl.getLatestGroups)
router.post("/:groupId/add", groupCtrl.addGroupParticipant);
router.post("/:groupId/remove", groupCtrl.removeGroupParticipant);
router.post("/:groupId/promote", groupCtrl.promoteGroupAdmin);
router.post("/:groupId/demote", groupCtrl.demoteGroupAdmin);
router.post("/:groupId/update-info", groupCtrl.updateGroupInfo);
router.post("/:groupId/settings", groupCtrl.updateGroupSettings);
router.get("/invite/:inviteCode", groupCtrl.getInviteInfo);
router.post("/join-by-invite", groupCtrl.joinGroupByInvite);
router.post("/:groupId/mention", groupCtrl.mentionInGroup);
router.post("/:groupId/message", groupCtrl.sendGroupMessage);
router.post("/:groupId/send-media",upload.array("file",10), groupCtrl.sendGroupMedia);
router.get("/getgroup",groupCtrl.getGroupIdByName);


export default router;
