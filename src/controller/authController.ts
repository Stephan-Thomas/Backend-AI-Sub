// src/controllers/authController.ts
import { Request, Response } from "express";
import { prisma } from "../prisma";
import bcrypt from "bcrypt";
import { signJwt } from "../utils/jwt";
import { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";
import { encrypt } from "../utils/crypto";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID!;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET!;
const BACKEND_BASE_URL =
  process.env.BACKEND_BASE_URL || "http://localhost:4000";
const oauth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  `${BACKEND_BASE_URL}/api/auth/google/callback`
);

// scopes for signing in + gmail connect (we may ask for gmail scope separately when connecting)
const basicScopes = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

export async function signup(req: Request, res: Response) {
  const { email, password, name } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: "Missing email/password" });
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return res.status(400).json({ error: "User already exists" });
  const hash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: { email, passwordHash: hash, name },
  });
  const token = signJwt({ id: user.id, email: user.email });
  res.json({
    token,
    user: { id: user.id, email: user.email, name: user.name },
  });
}

export async function login(req: Request, res: Response) {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: "Missing email/password" });
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.passwordHash)
    return res.status(401).json({ error: "Invalid credentials" });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: "Invalid credentials" });
  const token = signJwt({ id: user.id, email: user.email });
  res.json({
    token,
    user: { id: user.id, email: user.email, name: user.name },
  });
}

export function googleSignInUrl(req: Request, res: Response) {
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: basicScopes,
  });
  res.json({ url });
}

// Callback after Google OAuth sign-in
export async function googleCallback(req: Request, res: Response) {
  const code = req.query.code as string | undefined;
  if (!code) return res.status(400).json({ error: "Missing code" });

  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  // get userinfo
  const oauth2 = google.oauth2({ auth: oauth2Client, version: "v2" });
  const userinfo = await oauth2.userinfo.get();
  const email = userinfo.data.email!;
  const googleId = userinfo.data.id!;
  const name = userinfo.data.name;

  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        email,
        name,
        googleId,
      },
    });
  } else {
    // attach googleId if not present
    if (!user.googleId) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { googleId },
      });
    }
  }

  // Save Google tokens (encrypted)
  if (tokens.access_token && tokens.refresh_token) {
    await prisma.googleToken.upsert({
      where: { userId: user.id },
      update: {
        accessToken: encrypt(tokens.access_token),
        refreshToken: encrypt(tokens.refresh_token),
        scope: tokens.scope || undefined,
        expiryDate: tokens.expiry_date
          ? new Date(tokens.expiry_date)
          : undefined,
      },
      create: {
        userId: user.id,
        accessToken: encrypt(tokens.access_token),
        refreshToken: encrypt(tokens.refresh_token),
        scope: tokens.scope || undefined,
        expiryDate: tokens.expiry_date
          ? new Date(tokens.expiry_date)
          : undefined,
      },
    });
  }

  // Issue our JWT for frontend
  const jwt = signJwt({ id: user.id, email: user.email });
  // Set secure, HTTP-only cookie
  res.cookie("authToken", jwt, {
    httpOnly: true, // Can't be accessed via JavaScript
    secure: process.env.NODE_ENV === "production", // HTTPS only in production
    sameSite: "lax", // CSRF protection
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  });

  // Redirect without token in URL
  const frontend = process.env.FRONTEND_REDIRECT_URI || "http://localhost:3000";
  return res.redirect(`${frontend}/oauth-success`);
}
