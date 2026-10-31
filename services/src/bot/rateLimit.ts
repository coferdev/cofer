/**
 * Per-chat message limits for the main bot (Telegram FAQ: "In a group, bots are not be able to send
 * more than 20 messages per minute"; "In a single chat, avoid sending more than one message per
 * second"). Installed on bot.api, which the notifier shares, so every send and edit is counted.
 * The counts live in Redis, so the API process (command replies) and the notifier (vote cards)
 * share one budget per group.
 *
 * Over budget, a call is not sent; it fails with RateLimited (how long until a slot frees):
 *  - vote cards and notices: the notifier job waits that long (like Telegram's own 429)
 *  - a command's plain reply in a group: sent to the member by DM instead (a note says why);
 *    dropped only if that is not possible (the member never started the bot)
 *  - a personal (ephemeral) reply: privateReply falls back to a DM itself
 * A wait of up to SHORT_WAIT_MS is just waited. If the counter cannot be read, calls go through.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { Transformer } from "grammy";
import { logError } from "../core/errors";

// The owner's settings.
export const GROUP_LIMIT = { max: 18, windowMs: 60_000 }; // under Telegram's 20 a minute, with a margin
export const PRIVATE_LIMIT = { max: 1, windowMs: 1_000 };
export const SHORT_WAIT_MS = 1_500;
export const BUSY_NOTE = "(Sent here because the group chat is busy right now.)";

/** Methods that put a message in a chat (sends, edits, copies, forwards). Chat actions, deletes and callback answers do not. */
export function counts(method: string): boolean {
  return /^(send|edit|copy|forward)/.test(method) && method !== "sendChatAction";
}

/** "group" for groups, supergroups and channels; "private" for a one-to-one chat. */
export function chatKind(chatId: unknown): "group" | "private" | null {
  if (typeof chatId === "number") return chatId < 0 ? "group" : "private";
  if (typeof chatId === "string") return chatId.startsWith("@") || chatId.startsWith("-") ? "group" : "private";
  return null;
}

export class RateLimited extends Error {
  constructor(
    readonly chatId: number | string,
    readonly retryAfterMs: number,
  ) {
    super(`chat message budget used up; a slot frees in ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = "RateLimited";
  }
}

/** A sliding-window counter: 0 if a slot was taken, else the ms until one frees. */
export interface RateStore {
  take(key: string, max: number, windowMs: number, nowMs: number): Promise<number>;
}

export function memoryStore(): RateStore {
  const hits = new Map<string, number[]>();
  return {
    async take(key, max, windowMs, nowMs) {
      const live = (hits.get(key) ?? []).filter((t) => t > nowMs - windowMs);
      if (live.length < max) {
        live.push(nowMs);
        hits.set(key, live);
        return 0;
      }
      hits.set(key, live);
      return Math.max(1, live[0]! + windowMs - nowMs);
    },
  };
}

const TAKE = `
local key, now, win, max, id = KEYS[1], tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3]), ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - win)
if redis.call('ZCARD', key) < max then
  redis.call('ZADD', key, now, id)
  redis.call('PEXPIRE', key, win)
  return 0
end
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
return math.max(1, tonumber(oldest[2]) + win - now)
`;

/** The same counter in Redis (one atomic script per call), shared by every process. */
export function redisStore(r: { eval(script: string, keys: number, ...args: (string | number)[]): Promise<unknown> }): RateStore {
  return {
    take: async (key, max, windowMs, nowMs) => Number(await r.eval(TAKE, 1, `tg-rate:${key}`, nowMs, windowMs, max, randomUUID())),
  };
}

/** The member whose update is being handled (set per update by the bot), for the DM fallback. */
export const updateUser = new AsyncLocalStorage<{ userId?: number }>();

export function chatRateLimit(store: RateStore, opts: { now?: () => number; sleep?: (ms: number) => Promise<unknown> } = {}): Transformer {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));

  /** Takes a slot for this chat, waiting a short moment if one frees soon; else RateLimited. */
  async function take(chatId: number | string, kind: "group" | "private") {
    const l = kind === "group" ? GROUP_LIMIT : PRIVATE_LIMIT;
    for (let tries = 0; ; tries++) {
      let wait: number;
      try {
        wait = await store.take(String(chatId), l.max, l.windowMs, now());
      } catch (e) {
        logError("bot rate limit", e); // the counter is unavailable: let it through rather than block every message
        return;
      }
      if (wait === 0) return;
      if (wait > SHORT_WAIT_MS || tries > 0) throw new RateLimited(chatId, wait);
      await sleep(wait);
    }
  }

  const limited: Transformer = async (prev, method, payload, signal) => {
    const p = payload as Record<string, unknown>;
    const kind = counts(method) ? chatKind(p.chat_id) : null;
    if (!kind) return prev(method, payload, signal);
    try {
      await take(p.chat_id as number | string, kind);
    } catch (e) {
      // a command's plain reply in a busy group goes to the member by DM (never a personal ephemeral one: privateReply handles those)
      const userId = updateUser.getStore()?.userId;
      const plainGroupReply = method === "sendMessage" && kind === "group" && !p.ephemeral_message_parameters && userId !== undefined;
      if (!(e instanceof RateLimited) || !plainGroupReply) throw e;
      const { reply_parameters: _r, reply_to_message_id: _t, message_thread_id: _m, ...rest } = p;
      const dm = { ...rest, chat_id: userId, text: `${BUSY_NOTE}\n${String(p.text ?? "")}` };
      // no DM possible (never started the bot: Telegram answers "not ok"; or the DM budget is used): dropped
      let res: Awaited<ReturnType<typeof prev>>;
      try {
        res = await limited(prev, method, dm as never, signal);
      } catch {
        throw e;
      }
      if (!res.ok) throw e;
      return res;
    }
    return prev(method, payload, signal);
  };
  return limited;
}
