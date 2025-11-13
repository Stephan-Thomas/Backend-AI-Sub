// src/services/subscriptionService.ts
import { addDays } from "date-fns";
import { htmlToText } from "html-to-text";
import subs from "../data/subs.json";

type EmailMsg = { id: string; snippet?: string; payload?: any };

interface ParsedSub {
  provider: string;
  product?: string;
  amount?: number;
  currency?: string;
  startDate?: Date | null;
  nextBilling?: Date | null;
  tag?: string;
  rawData?: any;
}

// 🔥 Load providers from subs.json
const knownProviders = subs.map((s) => ({
  name: s.name.toLowerCase(),
  tag: s.tag,
  originalName: s.name,
}));

// 🧠 Decode HTML emails (for Canva and other HTML-heavy emails)
function decodeEmailBody(payload: any): string {
  if (!payload) return "";

  const decode = (data: string) => {
    try {
      return Buffer.from(data, "base64").toString("utf8");
    } catch {
      return "";
    }
  };

  const htmlToPlain = (raw: string) =>
    htmlToText(raw, {
      wordwrap: false,
      preserveNewlines: true,
      selectors: [
        { selector: "a", options: { ignoreHref: true } },
        { selector: "img", format: "skip" },
        { selector: "div", format: "block" },
        { selector: "span", format: "inline" },
      ],
    });

  // Check if there's a body.data field (single part email)
  if (payload.body?.data) {
    const raw = decode(payload.body.data);
    const mime = payload.mimeType?.toLowerCase() || "";
    const text =
      mime.includes("html") || raw.includes("<html") ? htmlToPlain(raw) : raw;
    return text.toLowerCase();
  }

  // Check if there are parts (multipart email)
  if (payload.parts?.length) {
    const extract = (parts: any[]): string =>
      parts
        .map((part) => {
          const mime = part.mimeType?.toLowerCase() || "";
          if (part.body?.data) {
            const raw = decode(part.body.data);
            return mime.includes("html") ? htmlToPlain(raw) : raw;
          }
          if (part.parts) return extract(part.parts);
          return "";
        })
        .join(" ");

    return extract(payload.parts).toLowerCase();
  }

  return "";
}

// 🔥 Find provider from headers or content
function findProvider(
  payload: any,
  fullText: string
): { name: string; tag: string } | null {
  if (!payload) return null;

  const headers = payload.headers || [];
  const from =
    headers
      .find((h: any) => h.name.toLowerCase() === "from")
      ?.value?.toLowerCase() || "";

  // Search in From header first
  for (const p of knownProviders) {
    if (from.includes(p.name)) {
      return { name: p.originalName, tag: p.tag };
    }
  }

  // Then search in email content
  for (const p of knownProviders) {
    if (fullText.includes(p.name)) {
      return { name: p.originalName, tag: p.tag };
    }
  }

  return null;
}

function extractAmount(text: string): {
  amount?: number;
  currency?: string;
} {
  const moneyRegex =
    /(?:USD|\$|EUR|€|NGN|₦|GBP|£)?\s?([0-9]+(?:[.,][0-9]{1,2})?)\s?(?:USD|EUR|NGN|₦|GBP|£)?/i;
  const m = text.match(moneyRegex);
  if (!m) return {};
  const raw = m[1].replace(",", ".");
  const num = parseFloat(raw);
  const currency = text.includes("₦")
    ? "NGN"
    : text.includes("$")
    ? "USD"
    : text.includes("€")
    ? "EUR"
    : text.includes("£")
    ? "GBP"
    : "USD";
  return { amount: num, currency };
}

export function parseSubscriptionsFromEmails(msgs: EmailMsg[]): ParsedSub[] {
  // 🔥 Step 1: Collect ALL potential subscriptions by provider
  const potentialByProvider = new Map<string, ParsedSub[]>();

  console.log(`\n🔍 Scanning ${msgs.length} emails for subscriptions...`);

  for (const m of msgs) {
    // Decode email body
    const decodedBody = decodeEmailBody(m.payload);
    const snippet = (m.snippet || "").toLowerCase();
    const fullText = decodedBody || snippet;

    // Find provider from subs.json
    const providerInfo = findProvider(m.payload, fullText);

    // 🔥 SKIP if no valid provider found
    if (!providerInfo) {
      console.log(`⏭️  Skipping email ${m.id} - no known provider detected`);
      continue;
    }

    // Check if this looks like a subscription email
    if (
      !/(subscription|renew|renewal|invoice|receipt|charged|payment|processed|billed)/i.test(
        fullText
      )
    ) {
      console.log(
        `⏭️  Skipping email ${m.id} from ${providerInfo.name} - no subscription keywords`
      );
      continue;
    }

    console.log(`✅ Found potential subscription: ${providerInfo.name}`);

    const { amount, currency } = extractAmount(fullText);

    // Get headers for subject and date
    const headers = m.payload?.headers || [];
    const subject =
      headers.find((h: any) => h.name.toLowerCase() === "subject")?.value || "";

    // Get email sent date and use it as startDate
    const sentDateStr = headers.find(
      (h: any) => h.name.toLowerCase() === "date"
    )?.value;
    const sentDate = sentDateStr ? new Date(sentDateStr) : new Date();

    // Calculate next billing as 30 days from sent date
    const startDate = sentDate;
    const nextBilling = addDays(sentDate, 30);

    // Product name guess
    let product: string | undefined;
    const prodMatch = fullText.match(
      /(plan|subscription|membership|premium|pro|plus|monthly|annual)[\s:]*([A-Za-z0-9 -]+)/i
    );
    if (prodMatch) product = prodMatch[2].trim().split("\n")[0];

    const subscription: ParsedSub = {
      provider: providerInfo.name,
      tag: providerInfo.tag,
      product,
      amount,
      currency,
      startDate,
      nextBilling,
      rawData: {
        messageId: m.id,
        subject,
        snippet: m.snippet,
        sentDate: sentDate.toISOString(),
      },
    };

    // 🔥 Add to provider group
    if (!potentialByProvider.has(providerInfo.name)) {
      potentialByProvider.set(providerInfo.name, []);
    }
    potentialByProvider.get(providerInfo.name)!.push(subscription);
  }

  // 🔥 Step 2: For each provider, pick the BEST subscription
  const finalSubscriptions: ParsedSub[] = [];

  console.log(`\n🎯 Comparing subscriptions by provider...`);

  for (const [provider, subscriptions] of potentialByProvider.entries()) {
    if (subscriptions.length === 1) {
      console.log(`✅ ${provider}: Only 1 subscription found, keeping it`);
      finalSubscriptions.push(subscriptions[0]);
    } else {
      console.log(
        `🔍 ${provider}: Found ${subscriptions.length} subscriptions, comparing...`
      );

      // Score all subscriptions
      const scored = subscriptions.map((sub) => ({
        sub,
        score: calculateSubscriptionScore(sub),
      }));

      // Sort by score (highest first)
      scored.sort((a, b) => b.score - a.score);

      // Log the comparison
      scored.forEach(({ sub, score }, index) => {
        console.log(
          `   ${index === 0 ? "👑" : "  "} Score: ${score} | Amount: ${
            sub.amount || "N/A"
          } | Date: ${sub.startDate?.toLocaleDateString() || "N/A"}`
        );
      });

      // Keep the best one
      finalSubscriptions.push(scored[0].sub);
      console.log(`✅ Selected best subscription for ${provider}`);
    }
  }

  console.log(
    `\n🎉 Final result: ${finalSubscriptions.length} unique subscriptions\n`
  );

  return finalSubscriptions;
}

// 🎯 Score a subscription to determine which is "best"
function calculateSubscriptionScore(sub: ParsedSub): number {
  let score = 0;

  // +10 points if it has an amount
  if (sub.amount && sub.amount > 0) score += 10;

  // +5 points if it has a product name
  if (sub.product && sub.product !== "unknown") score += 5;

  // +3 points if it has a currency
  if (sub.currency) score += 3;

  // +1 point for more recent date (prefer newer subscriptions)
  if (sub.startDate) {
    const daysSinceStart = Math.floor(
      (Date.now() - sub.startDate.getTime()) / (1000 * 60 * 60 * 24)
    );
    // More recent = higher score (max 30 days = 30 points)
    score += Math.max(0, 30 - daysSinceStart);
  }

  return score;
}
