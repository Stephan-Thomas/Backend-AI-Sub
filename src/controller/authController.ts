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

const basicScopes = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

// Helper: Set secure auth cookie
function setAuthCookie(res: Response, jwt: string) {
  res.cookie("authToken", jwt, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    path: "/",
  });
}

export async function signup(req: Request, res: Response) {
  try {
    // Input validation
    const { email, password, name } = req.body;

    if (!email || typeof email !== "string" || !email.includes("@")) {
      return res.status(400).json({ error: "Invalid email format" });
    }

    if (!password || password.length < 8) {
      return res
        .status(400)
        .json({ error: "Password must be at least 8 characters" });
    }

    // Check if user exists
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(400).json({ error: "Email already registered" });
    }

    // Hash password
    const hash = await bcrypt.hash(password, 10);

    // Create user
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: hash,
        name: name || email.split("@")[0],
      },
    });

    // Sign JWT
    const token = signJwt({ id: user.id, email: user.email });

    // Set secure cookie
    setAuthCookie(res, token);

    // Return user data (NOT the token)
    res.status(201).json({
      message: "Account created successfully",
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
    });
  } catch (error) {
    console.error("Signup error:", error);
    res.status(500).json({ error: "Failed to create account" });
  }
}

export async function login(req: Request, res: Response) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.passwordHash) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = signJwt({ id: user.id, email: user.email });

    // Set secure cookie
    setAuthCookie(res, token);

    // Return user data (NOT the token)
    res.json({
      message: "Logged in successfully",
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Login failed" });
  }
}

export function googleSignInUrl(req: Request, res: Response) {
  try {
    const url = oauth2Client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: basicScopes,
    });
    res.json({ url });
  } catch (error) {
    console.error("Google URL error:", error);
    res.status(500).json({ error: "Failed to generate login URL" });
  }
}

export async function googleCallback(req: Request, res: Response) {
  try {
    const code = req.query.code as string | undefined;
    if (!code) {
      return res.status(400).json({ error: "Missing authorization code" });
    }

    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Get user info from Google
    const oauth2 = google.oauth2({ auth: oauth2Client, version: "v2" });
    const userinfo = await oauth2.userinfo.get();

    const email = userinfo.data.email;
    const googleId = userinfo.data.id;
    const name = userinfo.data.name;

    if (!email || !googleId) {
      return res
        .status(400)
        .json({ error: "Failed to get user info from Google" });
    }

    // Find or create user
    let user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      user = await prisma.user.create({
        data: {
          email,
          name,
          googleId,
        },
      });
    } else if (!user.googleId) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { googleId },
      });
    }

    // Save Google tokens
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

    // Issue JWT
    const jwt = signJwt({ id: user.id, email: user.email });

    // Set secure cookie
    setAuthCookie(res, jwt);

    // Redirect to frontend success page
    const frontend =
      process.env.FRONTEND_REDIRECT_URI || "http://localhost:3000";
    return res.redirect(`${frontend}/oauth-success`);
  } catch (error) {
    console.error("Google callback error:", error);
    const frontend =
      process.env.FRONTEND_REDIRECT_URI || "http://localhost:3000";
    return res.redirect(`${frontend}/oauth-error?reason=authentication_failed`);
  }
}

// New endpoint: Get current authenticated user
export async function getMe(req: Request, res: Response) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        hasPaidForScanning: true,
        hasPaidForTelegram: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({ user });
  } catch (error) {
    console.error("Get user error:", error);
    res.status(500).json({ error: "Failed to fetch user" });
  }
}

// New endpoint: Logout
export function logout(req: Request, res: Response) {
  res.clearCookie("authToken", { path: "/" });
  res.json({ message: "Logged out successfully" });
}
