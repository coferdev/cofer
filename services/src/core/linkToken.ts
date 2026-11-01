/**
 * One-time signer links. The plain bot has no Mini App initData, so each `url` button carries a
 * short HMAC-signed token bound to (telegram user, chat, purpose, ref, expiry). The signer site
 * exchanges it once for a session. The token proves "this Telegram user tapped"; it never
 * authorizes money movement on its own (that needs the member's EIP-712 signature).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export type LinkPurpose = "onboard" | "sign" | "deposit" | "exit" | "claim" | "card" | "session";

export interface LinkClaims {
  tg: number; // telegram user id
  chat: number; // telegram chat id (group)
  p: LinkPurpose;
  ref: string; // proposal id / pot address / ""
  exp: number; // unix seconds
  jti: string; // single-use id
}

const b64u = (b: Buffer) => b.toString("base64url");

export function signLink(claims: LinkClaims, secret: string): string {
  const body = b64u(Buffer.from(JSON.stringify(claims)));
  const mac = b64u(createHmac("sha256", secret).update(body).digest());
  return `${body}.${mac}`;
}

export function verifyLink(token: string, secret: string, now = Math.floor(Date.now() / 1000)): LinkClaims {
  const [body, mac] = token.split(".");
  if (!body || !mac) throw new Error("malformed");
  const expect = createHmac("sha256", secret).update(body).digest();
  const got = Buffer.from(mac, "base64url");
  if (got.length !== expect.length || !timingSafeEqual(got, expect)) throw new Error("bad signature");
  const claims = JSON.parse(Buffer.from(body, "base64url").toString()) as LinkClaims;
  if (claims.exp < now) throw new Error("expired");
  return claims;
}

export function newJti(): string {
  return b64u(Buffer.from(crypto.getRandomValues(new Uint8Array(12))));
}

/** What the signer site says when an onboarding link was not made for a private chat. */
export const ONBOARD_DM_ONLY = "This setup link only works from a private chat with the bot. Open a private chat with the bot and send /start.";

/**
 * Onboarding links bind a key to a Telegram account, so they are only ever made for the member's
 * private chat with the bot (in Telegram, a private chat's id equals the user's id). A link made in
 * a group could be seen by others, so it is refused even if one exists.
 */
export function onboardLinkProblem(claims: Pick<LinkClaims, "p" | "tg" | "chat">): string | null {
  return claims.p === "onboard" && claims.chat !== claims.tg ? ONBOARD_DM_ONLY : null;
}
