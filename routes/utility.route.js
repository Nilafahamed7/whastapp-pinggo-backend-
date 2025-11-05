import express from "express";
import * as utilCtrl from "../controllers/utility.controller.js";

const router = express.Router();

// 🧩 Group utilities
router.get("/group/:groupId/members/export", utilCtrl.exportGroupMembers);
router.get("/export-group-members", utilCtrl.exportGroupMembers); // Alternative route
router.post("/group/:groupId/add-bulk", utilCtrl.addBulkMembers);

// 🧩 Checks & Info
router.get("/number/validity", utilCtrl.checkNumberValidity);
router.get("/contact/profile-pic", utilCtrl.getProfilePic);
router.get("/messages/history", utilCtrl.getMessageHistory);
router.post("/poll/create", utilCtrl.createPoll);

// 📺 Channels
router.get("/channels/list", utilCtrl.listChannels);

// 📍 Location
router.post("/location/send", utilCtrl.sendLocation);

export default router;
