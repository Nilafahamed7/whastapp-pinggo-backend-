

import express from "express";
import {
  checkContact,
  getContactInfo,
  blockContact,
  unblockContact,
} from "../controllers/contact.controller.js";

const router = express.Router();

router.post("/check", checkContact);
router.get("/info", getContactInfo);
router.post("/block", blockContact);
router.post("/unblock", unblockContact);

export default router;
