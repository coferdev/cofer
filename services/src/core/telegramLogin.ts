/**
 * Telegram Login Widget verification (for people who open the signer site directly, not via a
 * bot link). data_check_string = sorted "key=value" lines (excluding hash) joined by "\n";
 * secret = SHA256(bot_token); hash = hex(HMAC_SHA256(data_check_string, secret)).
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function dataCheckString(fields: Record<string, string | number>): string {
  return Object.keys(fields)
    .filter((k) => k !== "hash")
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("\n");
}

export function loginHash(fields: Record<string, string | number>, botToken: string): string {
  const secret = createHash("sha256").update(botToken).digest();
  return createHmac("sha256", secret).update(dataCheckString(fields)).digest("hex");
}

export function verifyTelegramLogin(
  fields: Record<string, string | number>,
  botToken: string,
  maxAgeSec = 86_400,
  now = Math.floor(Date.now() / 1000),
): boolean {
  const hash = String(fields.hash ?? "");
  if (!/^[0-9a-f]{64}$/.test(hash)) return false;
  const expect = Buffer.from(loginHash(fields, botToken), "hex");
  const got = Buffer.from(hash, "hex");
  if (!timingSafeEqual(expect, got)) return false;
  const authDate = Number(fields.auth_date ?? 0);
  return now - authDate <= maxAgeSec;
}
