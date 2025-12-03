// src/routes/gmail.ts
import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import {
  startGmailConnect,
  handleGmailCallback,
  fetchSubscriptions,
} from "../controller/gmailController";
import { checkScanningAccess } from "../middleware/payment";

const router = Router();

// returns URL the frontend should open to let user grant Gmail access (scoped to Gmail)
// uncomment this to scan without paying and uncomment the code below
router.get("/connect/url", requireAuth, startGmailConnect);

// uncomment this to add the pay before scanning
// router.get("/connect/url", requireAuth, checkScanningAccess, startGmailConnect);

// callback that receives `code` from Google when user grants Gmail scopes
router.get("/connect/callback", handleGmailCallback);

export default router;
