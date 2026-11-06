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

/** Proposal card: the approve button opens the signer page for the tapping user only (ephemeral link). */
export function proposalCard(proposalId: string): InlineKeyboard {
  return new InlineKeyboard().text("Approve / review", `sign:${proposalId}`).text("Details", `info:${proposalId}`);
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
