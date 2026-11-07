/**
 * Telegram compliance: this bot does Robinhood Chain (EVM) actions, so it must NEVER attach a Mini
 * App: no `web_app` buttons, no menu-button Mini App, no Main Mini App. Only `url` buttons that open
 * the external signer site, plus `callback_data` for read-only info. Enforced by test.
 */
import { InlineKeyboard } from "grammy";
import { signLink, newJti, type LinkPurpose } from "../core/linkToken";

export interface LinkCtx {
  publicUrl: string;
  secret: string;
  tgId: number;
  chatId: number;
  ttlSec?: number;
}

export function signerUrl(ctx: LinkCtx, purpose: LinkPurpose, ref = ""): string {
  const token = signLink(
    { tg: ctx.tgId, chat: ctx.chatId, p: purpose, ref, exp: Math.floor(Date.now() / 1000) + (ctx.ttlSec ?? 15 * 60), jti: newJti() },
    ctx.secret,
  );
  return `${ctx.publicUrl}/s/${token}`;
}

/**
 * The private "Open dashboard" link: a one-time "dashboard" link, always made for the member's own
 * private chat (chat id = user id), in the URL fragment so it never reaches a server log or another
 * site. The dashboard sends it once to its API and gets a short read-only session back.
 */
export function dashboardUrl(ctx: { dashboardUrl: string; secret: string; tgId: number; ttlSec: number }): string {
  const token = signLink(
    { tg: ctx.tgId, chat: ctx.tgId, p: "dashboard", ref: "", exp: Math.floor(Date.now() / 1000) + ctx.ttlSec, jti: newJti() },
    ctx.secret,
  );
  return `${ctx.dashboardUrl}/#t=${token}`;
}

/** The one-time token in a signer link (/s/<token>) or a dashboard link (#t=<token>), or "". */
export function linkTokenOf(href: string): string {
  const u = new URL(href);
  const hash = new URLSearchParams(u.hash.replace(/^#/, "")).get("t");
  return hash ?? u.pathname.split("/s/")[1] ?? "";
}

/**
 * Telegram refuses a button whose callback_data is over 64 bytes (BUTTON_DATA_INVALID), and a
 * proposal id written as 0x + 64 hex is 66 on its own. So card buttons carry the id's 32 bytes as
 * base64url: always 43 characters, which makes "sign:" / "info:" + id 48 bytes.
 */
const PROPOSAL_ID_HEX = /^0x[0-9a-fA-F]{64}$/;
const PROPOSAL_REF = /^[A-Za-z0-9_-]{43}$/;

/** A proposal id (0x + 64 hex) as the 43-character reference used in button data. Throws on anything else. */
export function encodeProposalRef(proposalId: string): string {
  if (!PROPOSAL_ID_HEX.test(proposalId)) throw new Error("not a proposal id");
  return Buffer.from(proposalId.slice(2), "hex").toString("base64url");
}

/** The proposal id (lowercase 0x + 64 hex) in a button reference, or null if it is malformed or the wrong length. */
export function decodeProposalRef(ref: string): `0x${string}` | null {
  if (!PROPOSAL_REF.test(ref)) return null;
  const bytes = Buffer.from(ref, "base64url");
  // exactly 32 bytes, and written the one canonical way (the last character's spare bits are zero)
  if (bytes.length !== 32 || bytes.toString("base64url") !== ref) return null;
  return `0x${bytes.toString("hex")}`;
}

/** Proposal card: the approve button opens the signer page for the tapping user only (ephemeral link). */
export function proposalCard(proposalId: string): InlineKeyboard {
  const ref = encodeProposalRef(proposalId);
  return new InlineKeyboard().text("Approve / review", `sign:${ref}`).text("Details", `info:${ref}`);
}

export function linkButton(label: string, url: string): InlineKeyboard {
  return new InlineKeyboard().url(label, url);
}

export function assertNoMiniApp(kb: InlineKeyboard): void {
  for (const row of kb.inline_keyboard) {
    for (const b of row) {
      if ("web_app" in b || "login_url" in b) throw new Error("Mini App / login_url buttons are not allowed on this bot");
    }
  }
}
