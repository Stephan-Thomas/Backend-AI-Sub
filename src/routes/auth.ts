// src/routes/auth.ts
import { Router } from "express";
import {
  signup,
  login,
  googleCallback,
  googleSignInUrl,
  getMe,
  logout,
} from "../controller/authController";
import { requireAuth } from "../middleware/auth";

const router = Router();

router.post("/signup", signup);
router.post("/login", login);
router.get("/google/url", googleSignInUrl);
router.get("/google/callback", googleCallback);

// Protected routes
router.get("/me", requireAuth, getMe);
router.post("/logout", requireAuth, logout);

export default router;
