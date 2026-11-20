/**
 * App sign-in (spec §6.3). The plain bot gives a url button with a one-time link to the App; the App exchanges it once
 * (session.exchange) for a session cookie. Links and sessions are HMAC-signed with the Arena's own secret
 * (ARENA_LINK_SECRET), never the group bot's, so an Arena link is never accepted by the group signer site and a group
 * link is never accepted here. Sessions identify a player; they never move money (every money action is signed by the
 * member's own key).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const APP_PURPOSES = ["app", "table", "duel", "freeroll"] as const;
export type AppPurpose = (typeof APP_PURPOSES)[number];

export interface AppLink {
  tg: number; // telegram user id
  chat: number; // the group it was made in (0 for a private chat)
  p: AppPurpose;
  ref: string; // the table, duel or freeroll it opens ("" for the App home)
  addr: string; // the member's account address, or "" when they have none
  exp: number; // unix seconds
  jti: string; // single-use id
}

export interface AppSession {
  tg: number;
  addr: string;
  exp: number;
}

export const LINK_TTL_S = 15 * 60;
export const SESSION_TTL_S = 12 * 3600;
export const SESSION_COOKIE = "cofer_arena";

const b64u = (b: Buffer) => b.toString("base64url");
const mac = (kind: string, body: string, secret: string) => createHmac("sha256", secret).update(`${kind}.${body}`).digest();

function seal(kind: "link" | "session", v: object, secret: string): string {
  const body = b64u(Buffer.from(JSON.stringify(v)));
  return `${body}.${b64u(mac(kind, body, secret))}`;
}

function open(kind: "link" | "session", token: string, secret: string): unknown {
  const [body, m, extra] = token.split(".");
  if (!body || !m || extra !== undefined) throw new Error("malformed");
  const want = mac(kind, body, secret);
  const got = Buffer.from(m, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw new Error("bad signature");
  return JSON.parse(Buffer.from(body, "base64url").toString());
}

export function newJti(): string {
  return b64u(Buffer.from(crypto.getRandomValues(new Uint8Array(12))));
}

export function signAppLink(l: Omit<AppLink, "exp" | "jti">, secret: string, now = Math.floor(Date.now() / 1000)): string {
  return seal("link", { ...l, exp: now + LINK_TTL_S, jti: newJti() }, secret);
}

export function verifyAppLink(token: string, secret: string, now = Math.floor(Date.now() / 1000)): AppLink {
  const c = open("link", token, secret) as AppLink;
  if (!APP_PURPOSES.includes(c.p)) throw new Error("not an App link");
  if (!Number.isSafeInteger(c.tg) || c.tg <= 0 || typeof c.jti !== "string" || !c.jti) throw new Error("malformed");
  if (typeof c.addr !== "string" || (c.addr !== "" && !/^0x[0-9a-fA-F]{40}$/.test(c.addr))) throw new Error("malformed");
  if (!(c.exp >= now)) throw new Error("expired");
  return c;
}

export function signSession(s: Omit<AppSession, "exp">, secret: string, now = Math.floor(Date.now() / 1000)): string {
  return seal("session", { ...s, exp: now + SESSION_TTL_S }, secret);
}

export function verifySession(token: string, secret: string, now = Math.floor(Date.now() / 1000)): AppSession | null {
  try {
    const s = open("session", token, secret) as AppSession;
    return Number.isSafeInteger(s.tg) && s.exp >= now ? s : null;
  } catch {
    return null;
  }
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/arena; Max-Age=${SESSION_TTL_S}; HttpOnly; Secure; SameSite=Strict`;
}

export function readCookie(header: string | null, name = SESSION_COOKIE): string | null {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}
