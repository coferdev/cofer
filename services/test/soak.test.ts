/**
 * M6 gate: rate-limit soak. 200 updates a minute for 10 minutes (simulated clock), through the real
 * Telegram client with the real limiter and Mini App guard, the real personal-reply path and the real
 * vote-card logic. Telegram and the database are stand-ins; the stand-in Telegram enforces the real
 * group limit itself (20 a minute) and answers 429 past it.
 *
 * Proves: no group gets more than 20 messages in ANY 60-second window (and our budget, 18, holds),
 * Telegram never answers 429, every vote ends with exactly one card showing its final state, no
 * personal link is ever posted publicly, and DMs stay at 1 a second per chat.
 */
import { describe, expect, test } from "bun:test";
import { Api } from "grammy";
import { chatRateLimit, GROUP_LIMIT, memoryStore, RateLimited, updateUser } from "../src/bot/rateLimit";
import { noMiniApp } from "../src/bot/noMiniApp";
import { privateReply, type PrivateReplyDeps } from "../src/bot/privateReply";
import { retryAfterMs, updateCard, type CardDeps } from "../src/notifier/notifier";

const T0 = 1_800_000_000_000;
const MINUTE = 60_000;
const LINK = "https://sign.example/s/";

/** Small deterministic random numbers, so every run is the same. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Call = { t: number; method: string; chat: number; text: string; ephemeral: boolean; status: number };

function soak(opts: { groups: number; perMinute: number; minutes: number; members: number; votes: number; seed: number }) {
  let clock = T0;
  const calls: Call[] = [];
  let nextMessageId = 1;
  const neverStarted = new Set<number>(); // members who never opened a chat with the bot

  // ---- stand-in Telegram, which enforces the real group limit itself ----
  const tgGroupLog = new Map<number, number[]>();
  const api = new Api("1:SOAK", {
    fetch: (async (url: string, init?: RequestInit) => {
      const method = String(url).split("/").pop()!;
      const b = JSON.parse(String(init?.body ?? "{}"));
      const chat = Number(b.chat_id);
      const ephemeral = !!b.ephemeral_message_parameters;
      const text = String(b.text ?? "");
      if (method === "answerCallbackQuery" || method === "deleteMessage") return Response.json({ ok: true, result: true });
      if (chat < 0) {
        const log = (tgGroupLog.get(chat) ?? []).filter((t) => t > clock - MINUTE);
        if (log.length >= 20) {
          calls.push({ t: clock, method, chat, text, ephemeral, status: 429 });
          return Response.json({ ok: false, error_code: 429, description: "Too Many Requests: retry after 30", parameters: { retry_after: 30 } });
        }
        log.push(clock);
        tgGroupLog.set(chat, log);
      } else if (neverStarted.has(chat)) {
        return Response.json({ ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" });
      }
      calls.push({ t: clock, method, chat, text, ephemeral, status: 200 });
      const id = ephemeral ? 0 : nextMessageId++;
      return Response.json({
        ok: true,
        result: { message_id: id, date: 0, chat: { id: chat, type: chat < 0 ? "supergroup" : "private" }, ...(ephemeral ? { receiver_user: { id: b.ephemeral_message_parameters.receiver_user_id, is_bot: false, first_name: "M" }, ephemeral_message_id: 1 } : {}) },
      });
    }) as unknown as typeof fetch,
  });
  api.config.use(noMiniApp);
  api.config.use(chatRateLimit(memoryStore(), { now: () => clock, sleep: async (ms) => void (clock += ms) }));

  // ---- the world: groups, members, votes ----
  const r = rng(opts.seed);
  const groups = Array.from({ length: opts.groups }, (_, i) => -1000 - i);
  const members = Array.from({ length: opts.members }, (_, i) => 5000 + i);
  for (const m of members) if (r() < 0.2) neverStarted.add(m);
  const votes = Array.from({ length: opts.votes }, (_, i) => ({ id: `0x${i.toString(16).padStart(64, "0")}`, chat: groups[i % groups.length]!, approvals: 0, messageId: null as number | null }));
  const cardText = (v: (typeof votes)[number]) => `Vote ${v.id.slice(-6)}: approvals ${v.approvals}/${opts.members}`;

  // ---- the notifier: one job per vote per 3 s bucket, run 1.5 s later; a held-back job waits and retries ----
  type Ev = { at: number; run: () => Promise<void> };
  const events: Ev[] = [];
  const schedule = (at: number, run: () => Promise<void>) => {
    let i = events.length;
    while (i > 0 && events[i - 1]!.at > at) i--;
    events.splice(i, 0, { at, run });
  };
  const pendingJobs = new Set<string>();
  const lastShown = new Map<string, string>();
  const cardDeps: CardDeps = {
    withLock: (_id, fn) => fn(),
    load: async (id) => {
      const v = votes.find((x) => x.id === id)!;
      return { chatId: v.chat, messageId: v.messageId, text: cardText(v), open: true };
    },
    send: async (chatId, text, kb) => (await api.sendMessage(chatId, text, kb ? { reply_markup: kb } : {})).message_id,
    edit: async (chatId, messageId, text, kb) => void (await api.editMessageText(chatId, messageId, text, kb ? { reply_markup: kb } : {})),
    saveMessageId: async (id, messageId) => void (votes.find((x) => x.id === id)!.messageId = messageId),
    lastShown,
  };
  let delayedJobs = 0;
  const runCardJob = (jobId: string, voteId: string) => async () => {
    try {
      await updateCard(voteId, cardDeps);
      pendingJobs.delete(jobId);
    } catch (e) {
      const wait = retryAfterMs(e);
      if (wait === null) throw e;
      delayedJobs++;
      schedule(clock + wait, runCardJob(jobId, voteId)); // moveToDelayed: no try used up
    }
  };
  const enqueueCard = (voteId: string) => {
    const jobId = `card:${voteId}:${Math.floor(clock / 3000)}`;
    if (pendingJobs.has(jobId)) return;
    pendingJobs.add(jobId);
    schedule(clock + 1500, runCardJob(jobId, voteId));
  };

  // ---- the bot side: what each kind of update sends ----
  let dropped = 0;
  const leaks: number[] = [];
  const privateDeps: PrivateReplyDeps = {
    send: (chatId, text, o) => api.sendMessage(chatId, text, o as never),
    remove: (chatId, id) => api.deleteMessage(chatId, id),
    burn: async () => {},
    leaked: async (chatId) => void leaks.push(chatId),
  };
  /** ctx.reply as the bot does it: a reply the busy group cannot take goes by DM, else is dropped. */
  const plainReply = async (chat: number, text: string) => {
    try {
      await api.sendMessage(chat, text);
    } catch (e) {
      if (!(e instanceof RateLimited)) throw e;
      dropped++;
    }
  };
  const update = (kind: number, chat: number, user: number) =>
    updateUser.run({ userId: user }, async () => {
      if (kind < 0.4) return plainReply(chat, "Group account 0xpot\nUSDG: 120 (120 USDG)"); // /pot, /help
      if (kind < 0.65 || kind >= 0.9) {
        // /me, /deposit, /exit; or a button tap ("Approve / review")
        if (kind >= 0.9) await api.answerCallbackQuery(`cb${user}`);
        const r = await privateReply(privateDeps, {
          chatId: chat,
          chatType: "supergroup",
          userId: user,
          callbackQueryId: kind >= 0.9 ? `cb${user}` : undefined,
          text: "Add USDG to the group account.",
          link: { label: "Deposit", make: () => `${LINK}${user}-${clock}` },
        });
        if (r === "none") await plainReply(chat, "Open a private chat with me first, then try again.");
        return;
      }
      // a member signs a vote: the card has to show it
      const groupVotes = votes.filter((v) => v.chat === chat);
      const v = groupVotes[Math.floor(r() * groupVotes.length)]!;
      v.approvals++;
      enqueueCard(v.id);
    });

  // ---- load: perMinute updates a minute, evenly spaced, random kinds, groups and members ----
  const total = opts.perMinute * opts.minutes;
  const gap = MINUTE / opts.perMinute;
  for (let i = 0; i < total; i++) {
    const kind = r();
    const chat = groups[Math.floor(r() * groups.length)]!;
    const user = members[Math.floor(r() * members.length)]!;
    schedule(T0 + i * gap, () => update(kind, chat, user));
  }

  return {
    async run() {
      while (events.length) {
        const ev = events.shift()!;
        clock = Math.max(clock, ev.at);
        await ev.run();
      }
    },
    calls,
    votes,
    cardText,
    total,
    stats: () => ({ dropped, delayedJobs, leaks }),
    neverStarted,
  };
}

/** Most counted messages (sends and edits) one chat received in any window of `windowMs`. */
function maxInWindow(times: number[], windowMs: number): number {
  let best = 0;
  for (let i = 0, j = 0; j < times.length; j++) {
    while (times[j]! - times[i]! >= windowMs) i++;
    best = Math.max(best, j - i + 1);
  }
  return best;
}

function check(s: ReturnType<typeof soak>) {
  const delivered = s.calls.filter((c) => c.status === 200);
  const byChat = new Map<number, number[]>();
  for (const c of delivered) byChat.set(c.chat, [...(byChat.get(c.chat) ?? []), c.t]);
  const groupMax = Math.max(...[...byChat].filter(([chat]) => chat < 0).map(([, ts]) => maxInWindow(ts, MINUTE)));
  const dmMax = Math.max(0, ...[...byChat].filter(([chat]) => chat > 0).map(([, ts]) => maxInWindow(ts, 1_000)));
  return { delivered, groupMax, dmMax };
}

describe("rate-limit soak: 200 updates a minute for 10 minutes", () => {
  for (const scenario of [
    { name: "all in one busy group", groups: 1, seed: 1 },
    { name: "spread over 10 groups", groups: 10, seed: 2 },
  ]) {
    test(scenario.name, async () => {
      const s = soak({ groups: scenario.groups, perMinute: 200, minutes: 10, members: 30, votes: 20, seed: scenario.seed });
      await s.run();
      const { delivered, groupMax, dmMax } = check(s);

      // the load really was 200 a minute
      expect(s.total).toBe(2000);

      // the gate: never more than 20 a minute in any group, in any 60-second window (our budget: 18)
      expect(groupMax).toBeLessThanOrEqual(20);
      expect(groupMax).toBeLessThanOrEqual(GROUP_LIMIT.max);
      expect(s.calls.filter((c) => c.status === 429)).toEqual([]); // Telegram never had to refuse one

      // every vote: exactly one card, showing its final state once the queue has drained
      for (const v of s.votes) {
        if (v.approvals === 0) continue;
        const cardSends = delivered.filter((c) => c.method === "sendMessage" && c.text.startsWith(`Vote ${v.id.slice(-6)}`));
        expect({ vote: v.id.slice(-6), cards: cardSends.length }).toEqual({ vote: v.id.slice(-6), cards: 1 });
        const last = delivered.filter((c) => c.chat === v.chat && c.text.startsWith(`Vote ${v.id.slice(-6)}`)).at(-1)!;
        expect(last.text).toBe(s.cardText(v));
      }

      // no personal link ever posted for the whole group to see
      expect(delivered.filter((c) => c.chat < 0 && c.text.includes(LINK) && !c.ephemeral)).toEqual([]);
      expect(s.stats().leaks).toEqual([]);

      // DMs (busy-group replies and personal fallbacks) stay at 1 a second per chat
      expect(dmMax).toBeLessThanOrEqual(1);

      // nothing went to a member who never started the bot
      expect(delivered.filter((c) => s.neverStarted.has(c.chat))).toEqual([]);
    });
  }

  test("the busy group really was over budget (the limiter had work to do)", async () => {
    const s = soak({ groups: 1, perMinute: 200, minutes: 10, members: 30, votes: 20, seed: 1 });
    await s.run();
    const { delivered } = check(s);
    expect(s.stats().delayedJobs).toBeGreaterThan(0); // vote cards had to wait
    expect(delivered.filter((c) => c.chat > 0).length).toBeGreaterThan(100); // replies went by DM
  });
});
