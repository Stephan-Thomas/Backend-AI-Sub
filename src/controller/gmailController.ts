// src/controllers/gmailController.ts
import { Request, Response } from "express";
import { prisma } from "../prisma";
import { google } from "googleapis";
import { encrypt } from "../utils/crypto";
import { scanUserGmailForSubscriptions } from "../services/gmailServices";
import { verifyJwt, signJwt } from "../utils/jwt";
import crypto from "crypto";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID!;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET!;
const BACKEND_BASE_URL =
  process.env.BACKEND_BASE_URL || "http://localhost:4000";

const redirectUri = `${BACKEND_BASE_URL}/api/gmail/connect/callback`;
const oauth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  redirectUri
);

const gmailScopes = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
];

// Store temporary state (in production, use Redis)
const stateStore = new Map<string, { userId: string; createdAt: number }>();

// Clean up old states every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of stateStore.entries()) {
    if (now - value.createdAt > 10 * 60 * 1000) {
      // 10 min expiry
      stateStore.delete(key);
    }
  }
}, 5 * 60 * 1000);

export async function startGmailConnect(req: Request, res: Response) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Generate a secure random state
    const state = crypto.randomBytes(32).toString("hex");
    stateStore.set(state, { userId, createdAt: Date.now() });

    const url = oauth2Client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: gmailScopes,
      state, // Just pass the state, not the token
    });

    res.json({ url });
  } catch (error) {
    console.error("Gmail connect URL error:", error);
    res.status(500).json({ error: "Failed to generate Gmail connect URL" });
  }
}

export async function handleGmailCallback(req: Request, res: Response) {
  try {
    const code = req.query.code as string;
    const state = req.query.state as string;

    if (!code || !state) {
      return res.status(400).json({ error: "Missing code or state" });
    }

    // Verify state (security check)
    const stateData = stateStore.get(state);
    if (!stateData) {
      return res.status(400).json({ error: "Invalid or expired state" });
    }

    const userId = stateData.userId;
    stateStore.delete(state); // Consume the state (can only be used once)

    // Exchange code for tokens
    const { tokens } = await oauth2Client.getToken(code);
    if (!tokens.access_token) {
      return res.status(400).json({ error: "Failed to get access token" });
    }

    // Save tokens to database
    await prisma.googleToken.upsert({
      where: { userId },
      update: {
        accessToken: encrypt(tokens.access_token),
        refreshToken: tokens.refresh_token
          ? encrypt(tokens.refresh_token)
          : undefined,
        scope: tokens.scope || undefined,
        expiryDate: tokens.expiry_date
          ? new Date(tokens.expiry_date)
          : undefined,
      },
      create: {
        userId,
        accessToken: encrypt(tokens.access_token),
        refreshToken: tokens.refresh_token ? encrypt(tokens.refresh_token) : "",
        scope: tokens.scope || undefined,
        expiryDate: tokens.expiry_date
          ? new Date(tokens.expiry_date)
          : undefined,
      },
    });

    // Optionally scan Gmail immediately
    try {
      await scanUserGmailForSubscriptions(userId);
    } catch (err) {
      console.error("Gmail scan error:", err);
      // Don't fail the callback if scan fails
    }

    const frontend =
      process.env.FRONTEND_REDIRECT_URI || "http://localhost:3000";
    return res.redirect(`${frontend}/gmail-connected?success=true`);
  } catch (error) {
    console.error("Gmail callback error:", error);
    const frontend =
      process.env.FRONTEND_REDIRECT_URI || "http://localhost:3000";
    return res.redirect(
      `${frontend}/gmail-connected?error=authentication_failed`
    );
  }
}

export async function fetchSubscriptions(req: Request, res: Response) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const subs = await prisma.subscription.findMany({
      where: { userId },
      orderBy: { nextBilling: "asc" },
    });

    res.json({ subscriptions: subs });
  } catch (error) {
    console.error("Fetch subscriptions error:", error);
    res.status(500).json({ error: "Failed to fetch subscriptions" });
  }
}
