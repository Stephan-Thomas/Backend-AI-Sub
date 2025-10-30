import { Request, Response } from "express";
import { prisma } from "../prisma";
import { google } from "googleapis";
import { encrypt } from "../utils/crypto";
import { scanUserGmailForSubscriptions } from "../services/gmailServices";
import { signJwt, verifyJwt } from "../utils/jwt";

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

// Gmail scopes for reading user inbox
const gmailScopes = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
];

export async function startGmailConnect(req: Request, res: Response) {
  const user = req.user!;
  const authToken = signJwt({ id: user.id, email: user.email });

  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: gmailScopes,
    state: JSON.stringify({ token: authToken }),
  });

  res.json({ url });
}

export async function handleGmailCallback(req: Request, res: Response) {
  const code = req.query.code as string;
  const stateRaw = req.query.state as string;

  if (!code) return res.status(400).json({ error: "Missing code" });
  if (!stateRaw) return res.status(400).json({ error: "Missing state" });

  let state;
  try {
    state = JSON.parse(stateRaw);
  } catch {
    return res.status(400).json({ error: "Invalid state param" });
  }

  const authToken = state.token;
  if (!authToken)
    return res.status(400).json({ error: "Missing token in state" });

  const { verifyJwt } = require("../utils/jwt");
  const payload = verifyJwt(authToken);
  if (!payload) return res.status(401).json({ error: "Invalid token" });

  const userId = payload.id;

  // get tokens from Google
  const { tokens } = await oauth2Client.getToken(code);

  if (!tokens.access_token)
    return res.status(400).json({ error: "Missing access token from Google" });

  // store tokens in DB
  await prisma.googleToken.upsert({
    where: { userId },
    update: {
      accessToken: encrypt(tokens.access_token),
      refreshToken: tokens.refresh_token ? encrypt(tokens.refresh_token) : "",
      scope: tokens.scope || undefined,
      expiryDate: tokens.expiry_date ? new Date(tokens.expiry_date) : undefined,
    },
    create: {
      userId,
      accessToken: encrypt(tokens.access_token),
      refreshToken: tokens.refresh_token ? encrypt(tokens.refresh_token) : "",
      scope: tokens.scope || undefined,
      expiryDate: tokens.expiry_date ? new Date(tokens.expiry_date) : undefined,
    },
  });

  // optional: immediately scan Gmail
  const results = await scanUserGmailForSubscriptions(userId);

  // redirect to frontend
  const frontend = process.env.FRONTEND_REDIRECT_URI || "http://localhost:3000";
  return res.redirect(`${frontend}/gmail-connected?scan=true`);
}

export async function fetchSubscriptions(req: Request, res: Response) {
  const user = req.user!;
  const subs = await prisma.subscription.findMany({
    where: { userId: user.id },
    orderBy: { nextBilling: "asc" },
  });
  res.json({ subscriptions: subs });
}
