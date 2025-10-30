// src/utils/crypto.ts
import crypto from "crypto";
const ALGO = "aes-256-gcm";

const key = Buffer.from(process.env.ENCRYPTION_KEY || "", "hex");
if (key.length !== 32) {
  throw new Error("ENCRYPTION_KEY must be 32 bytes hex (64 hex chars)");
}

export function encrypt(text: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(text, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export function decrypt(encrypted: string) {
  const data = Buffer.from(encrypted, "base64");
  const iv = data.slice(0, 12);
  const tag = data.slice(12, 28);
  const text = data.slice(28);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(text), decipher.final()]);
  return decrypted.toString("utf8");
}
