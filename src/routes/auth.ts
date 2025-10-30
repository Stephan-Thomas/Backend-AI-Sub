// src/routes/auth.ts
import { Router } from "express";
import {
  signup,
  login,
  googleCallback,
  googleSignInUrl,
} from "../controller/authController";
const router = Router();

router.post("/signup", signup);
router.post("/login", login);

// return URL the frontend should open to start Google OAuth sign-in
router.get("/google/url", googleSignInUrl);

// Callback endpoint that Google will redirect to with `code`.
// You may choose to do code exchange on server and create user + issue JWT
router.get("/google/callback", googleCallback);

export default router;
