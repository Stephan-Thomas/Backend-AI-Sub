// src/app.ts
import express from "express";
import cookieParser from "cookie-parser";
import authRoutes from "./routes/auth";
import gmailRoutes from "./routes/gmail";
import subscriptionRoutes from "./routes/subscription";
import paymentRoutes from "./routes/payments";
import webhookRoutes from "./routes/webhooks";
import telegramRoutes from "./routes/telegram";
import cors from "cors";

const app = express();

// CORS with credentials
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Webhooks FIRST (before JSON parser)
app.use("/api/webhooks", webhookRoutes);

// JSON parser for everything else
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(cookieParser());

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/gmail", gmailRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/telegram", telegramRoutes);
app.use("/api/subscriptions", subscriptionRoutes);

// Health check
app.get("/", (req, res) =>
  res.json({ ok: true, message: "Server is running" })
);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Global error handler
app.use(
  (
    err: any,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
);

export default app;
