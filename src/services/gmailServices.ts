// src/services/gmailService.ts
import { google } from "googleapis";
import { prisma } from "../prisma";
import { decrypt, encrypt } from "../utils/crypto";
import { parseSubscriptionsFromEmails } from "./subscriptionService";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID!;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET!;
const oauth2ClientFactory = (redirectUri: string) =>
  new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, redirectUri);

// fetch messages and run parser; save subscriptions into DB
export async function scanUserGmailForSubscriptions(userId: string) {
  // locate token
  const token = await prisma.googleToken.findUnique({ where: { userId } });
  if (!token) throw new Error("No google token for user");

  const accessToken = decrypt(token.accessToken);
  const refreshToken = decrypt(token.refreshToken);
  const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
  oauth2Client.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken,
  });

  const gmail = google.gmail({ version: "v1", auth: oauth2Client });

  // 1) list messages — we'll search for common subscription keywords and known senders
  // Note: Gmail API allows `q` parameter similar to search box (helps narrow down).
  const searchQueries = [
    'subject:(subscription OR receipt OR invoice OR "payment" OR "renewal" OR "FirstBank")',
    'from:billing OR from:receipt OR from:invoice OR "donotreply" OR "no-reply"',
    'subject:(welcome OR "your subscription")',
  ];

  const collectedEmails: { id: string; snippet?: string }[] = [];

  for (const q of searchQueries) {
    try {
      const list = await gmail.users.messages.list({
        userId: "me",
        q,
        maxResults: 200,
      });
      const msgs = list.data.messages || [];
      for (const m of msgs) {
        collectedEmails.push({ id: m.id! });
      }
    } catch (err) {
      console.error("Gmail list error", err);
    }
  }

  // Deduplicate ids
  const uniqueIds = Array.from(new Set(collectedEmails.map((x) => x.id))).slice(
    0,
    500
  ); // limit

  // Fetch message details in batches
  const detailed: { id: string; snippet?: string; payload?: any }[] = [];
  for (const id of uniqueIds) {
    try {
      const resp = await gmail.users.messages.get({
        userId: "me",
        id,
        format: "full",
      });
      detailed.push({
        id,
        snippet: resp.data.snippet ?? undefined, // <-- turns null → undefined,
        payload: resp.data.payload,
      });
    } catch (err) {
      console.warn("Failed to get message", id, err);
    }
  }

  // 2) Parse subscriptions from messages
  const parsed = parseSubscriptionsFromEmails(detailed);

  // 3) Upsert subscriptions into DB for user
  const saved: any[] = [];
  for (const p of parsed) {
    // crude matching: provider + product + user
    const existing = await prisma.subscription.findFirst({
      where: { userId, provider: p.provider, product: p.product },
    });
    if (existing) {
      const updated = await prisma.subscription.update({
        where: { id: existing.id },
        data: {
          amount: p.amount ?? existing.amount,
          currency: p.currency ?? existing.currency,
          startDate: p.startDate ?? existing.startDate,
          nextBilling: p.nextBilling ?? existing.nextBilling,
          rawData: p.rawData ?? existing.rawData,
        },
      });
      saved.push(updated);
    } else {
      const created = await prisma.subscription.create({
        data: {
          userId,
          provider: p.provider,
          product: p.product,
          amount: p.amount,
          currency: p.currency,
          startDate: p.startDate,
          nextBilling: p.nextBilling,
          rawData: p.rawData,
        },
      });
      saved.push(created);
    }
  }

  return saved;
}
