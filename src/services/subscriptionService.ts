// src/services/subscriptionService.ts
import { addDays } from "date-fns";
import { htmlToText } from "html-to-text";

type EmailMsg = { id: string; snippet?: string; payload?: any };

interface ParsedSub {
  provider: string;
  product?: string;
  amount?: number;
  currency?: string;
  startDate?: Date | null;
  nextBilling?: Date | null;
  rawData?: any;
}

const knownProviders = [
  "openai",
  "perplexity",
  "claude",
  "spotify",
  "youtube",
  "netflix",
  "stripe",
  "apple",
  "amazon",
  "starlink",
  "canva",
];

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

function guessProviderFromHeaders(payload: any): string | null {
  if (!payload) return null;
  const headers = payload.headers || [];
  const from =
    headers
      .find((h: any) => h.name.toLowerCase() === "from")
      ?.value?.toLowerCase() || "";
  for (const p of knownProviders) {
    if (from.includes(p)) return p;
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

function extractDates(text: string): {
  start?: Date | null;
  next?: Date | null;
} {
  const iso = text.match(/\b(20\d{2}[-\/]\d{1,2}[-\/]\d{1,2})\b/);
  if (iso) {
    try {
      const d = new Date(iso[1]);
      return { start: d, next: addDays(d, 30) };
    } catch {}
  }

  const longDate = text.match(
    /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+\d{1,2},\s*\d{4}\b/i
  );
  if (longDate) {
    try {
      const d = new Date(longDate[0]);
      return { start: d, next: addDays(d, 30) };
    } catch {}
  }

  return { start: null, next: null };
}

export function parseSubscriptionsFromEmails(msgs: EmailMsg[]): ParsedSub[] {
  const results: ParsedSub[] = [];

  for (const m of msgs) {
    // 🔥 KEY FIX: Use decoded body for HTML emails, fallback to snippet for plain text
    const decodedBody = decodeEmailBody(m.payload);
    const snippet = (m.snippet || "").toLowerCase();

    // Combine both - use decoded body if available, otherwise use snippet
    const fullText = decodedBody || snippet;

    const providerFromHeader = guessProviderFromHeaders(m.payload);
    const provider =
      providerFromHeader ||
      knownProviders.find((p) => fullText.includes(p)) ||
      "unknown";

    // Check if this looks like a subscription email
    if (
      !/(subscription|renew|renewal|invoice|receipt|charged|payment|processed|billed)/i.test(
        fullText
      )
    )
      continue;

    const { amount, currency } = extractAmount(fullText);
    const { start, next } = extractDates(fullText);

    // Get subject for better product detection
    const headers = m.payload?.headers || [];
    const subject =
      headers.find((h: any) => h.name.toLowerCase() === "subject")?.value || "";

    // Product name guess
    let product: string | undefined;
    const prodMatch = fullText.match(
      /(plan|subscription|membership|premium|pro|plus|monthly|annual)[\s:]*([A-Za-z0-9 -]+)/i
    );
    if (prodMatch) product = prodMatch[2].trim().split("\n")[0];

    results.push({
      provider,
      product,
      amount,
      currency,
      startDate: start || null,
      nextBilling: next || null,
      rawData: {
        messageId: m.id,
        subject,
        snippet: m.snippet,
      },
    });
  }

  // Dedupe by provider + product
  const grouped = new Map<string, ParsedSub>();
  for (const r of results) {
    const key = `${r.provider}::${r.product ?? "unknown"}`;
    if (!grouped.has(key)) grouped.set(key, r);
  }

  return Array.from(grouped.values());
}
