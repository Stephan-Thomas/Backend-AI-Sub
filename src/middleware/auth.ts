// src/middleware/auth.ts
import { Request, Response, NextFunction } from "express";
import { verifyJwt } from "../utils/jwt";

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    // Try to get token from cookie first (preferred method)
    let token = req.cookies.authToken;

    // Fallback to Authorization header (for API clients)
    if (!token) {
      const auth = req.headers.authorization;
      if (auth?.startsWith("Bearer ")) {
        token = auth.slice("Bearer ".length);
      }
    }

    if (!token) {
      return res.status(401).json({ error: "Unauthorized: No token provided" });
    }

    const payload = verifyJwt(token);
    if (!payload) {
      return res.status(401).json({ error: "Unauthorized: Invalid token" });
    }

    // Attach user to request
    req.user = { id: payload.id, email: payload.email };
    next();
  } catch (error) {
    return res.status(401).json({ error: "Unauthorized" });
  }
}
