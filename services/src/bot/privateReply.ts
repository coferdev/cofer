/**
 * Replies only the member should see: personal signer links, their share and allowance. In a group
 * it is an ephemeral message (Bot API 10.3, ephemeral_message_parameters), visible only to that
 * member; if that fails, a DM. The reply Telegram returns is checked: an ephemeral message has
 * message_id 0 and a receiver. One that came back as an ordinary group message is deleted at once,
 * its one-time link is cancelled, the ops chat is told, and the member gets it by DM with a fresh link.
 */
import type { Message } from "grammy/types";
import { linkButton, assertNoMiniApp } from "./keyboards";

export type Delivered = "ephemeral" | "dm" | "none";

type Sent = Pick<Message, "message_id" | "receiver_user" | "ephemeral_message_id">;

export interface PrivateReplyDeps {
  send(chatId: number, text: string, opts: Record<string, unknown>): Promise<Sent>;
  remove(chatId: number, messageId: number): Promise<unknown>;
  /** Cancels the one-time link in a message that leaked (marks it used). */
  burn(href: string): Promise<void>;
  /** Reports a leak to the log and the ops chat. Never throws. */
  leaked(chatId: number): Promise<void>;
}

export interface PrivateReply {
  chatId: number;
  chatType: string;
  userId: number;
  callbackQueryId?: string;
  text: string;
  /** A personal link: made fresh each time it is needed, so a cancelled one is never sent again. */
  link?: { label: string; make(): string };
}

/** True if Telegram delivered it to this member only. */
export function isEphemeral(m: Sent, userId: number): boolean {
  return m.message_id === 0 || m.ephemeral_message_id !== undefined || m.receiver_user?.id === userId;
}

function markup(link: PrivateReply["link"]): { href?: string; opts: Record<string, unknown> } {
  if (!link) return { opts: {} };
  const href = link.make();
  const kb = linkButton(link.label, href);
  assertNoMiniApp(kb);
  return { href, opts: { reply_markup: kb } };
}

export async function privateReply(d: PrivateReplyDeps, r: PrivateReply): Promise<Delivered> {
  if (r.chatType === "private") {
    try {
      await d.send(r.chatId, r.text, markup(r.link).opts);
      return "dm";
    } catch {
      return "none";
    }
  }

  let leakedLink = false;
  const first = markup(r.link);
  try {
    const m = await d.send(r.chatId, r.text, { ...first.opts, ephemeral_message_parameters: { receiver_user_id: r.userId, callback_query_id: r.callbackQueryId } });
    if (isEphemeral(m, r.userId)) return "ephemeral";
    // shown to the whole group: take it down, cancel its link, tell the ops chat
    await d.remove(r.chatId, m.message_id).catch(() => {});
    if (first.href) {
      leakedLink = true;
      await d.burn(first.href).catch(() => {});
    }
    await d.leaked(r.chatId);
  } catch {
    /* not delivered at all: nothing leaked, try a DM */
  }

  try {
    await d.send(r.userId, r.text, leakedLink ? markup(r.link).opts : first.opts);
    return "dm";
  } catch {
    return "none";
  }
}
