// src/services/gmailService.ts
import { google } from "googleapis";
import { prisma } from "../prisma";
import { decrypt, encrypt } from "../utils/crypto";
import { parseSubscriptionsFromEmails } from "./subscriptionService";
import subs from "../data/subs.json";

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

  // 🔥 Calculate date range: from January 1st of last year to now
  const now = new Date();
  const currentYear = now.getFullYear();
  const lastYear = currentYear - 1;
  const startDate = new Date(lastYear, 0, 1); // January 1st of last year

  // Format dates for Gmail search (YYYY/MM/DD)
  const afterDate = `${startDate.getFullYear()}/${String(
    startDate.getMonth() + 1
  ).padStart(2, "0")}/${String(startDate.getDate()).padStart(2, "0")}`;

  console.log(`📅 Searching emails from ${afterDate} to now`);

  // 1) list messages with date filter
  const searchQueries = [
    `after:${afterDate} subject:(subscription OR receipt OR invoice OR "payment" OR "renewal")`,
    `after:${afterDate} from:billing OR from:receipt OR from:invoice OR "donotreply" OR "no-reply"`,
    `after:${afterDate} subject:(welcome OR "your subscription")`,
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

  console.log(`📧 Found ${uniqueIds.length} unique emails to analyze`);

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
        snippet: resp.data.snippet ?? undefined,
        payload: resp.data.payload,
      });
    } catch (err) {
      console.warn("Failed to get message", id, err);
    }
  }

  // 2) Parse subscriptions from messages
  const parsed = parseSubscriptionsFromEmails(detailed);

  console.log(`✅ Parsed ${parsed.length} subscriptions`);

  // 3) Upsert subscriptions into DB for user
  const saved: any[] = [];
  for (const p of parsed) {
    // 🔥 Look up the tag from subs.json based on provider name
    const providerInfo = subs.find(
      (s) => s.name.toLowerCase() === p.provider.toLowerCase()
    );
    const tag = providerInfo?.tag || "other";

    console.log(`💾 Processing ${p.provider} (${p.currency} ${p.amount})...`);

    // 🔥 MATCH BY PROVIDER NAME ONLY (ignore product variations)
    // This prevents duplicates like "Canva Pro" vs "Canva Premium" vs "Canva"
    const existing = await prisma.subscription.findFirst({
      where: {
        userId,
        provider: p.provider,
      },
    });

    if (existing) {
      // 🔥 ALWAYS UPDATE - replace old data with new data
      const updated = await prisma.subscription.update({
        where: { id: existing.id },
        data: {
          amount: p.amount,
          currency: p.currency,
          product: p.product || existing.product,
          startDate: p.startDate,
          nextBilling: p.nextBilling,
          tag: tag,
          rawData: p.rawData,
        },
      });
      saved.push(updated);
      console.log(
        `✏️  Updated ${p.provider}: ${existing.amount} → ${p.amount} (newer data)`
      );
    } else {
      // Create new subscription
      const created = await prisma.subscription.create({
        data: {
          userId,
          provider: p.provider,
          product: p.product,
          amount: p.amount,
          currency: p.currency,
          startDate: p.startDate,
          nextBilling: p.nextBilling,
          tag: tag,
          rawData: p.rawData,
        },
      });
      saved.push(created);
      console.log(`✨ Created new subscription: ${p.provider} (${tag})`);
    }
  }

  console.log(`💾 Saved ${saved.length} subscriptions to database`);

  return saved;
}
