import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Api } from "grammy";
import { BUSY_NOTE, chatKind, chatRateLimit, counts, GROUP_LIMIT, memoryStore, PRIVATE_LIMIT, RateLimited, type RateStore, updateUser } from "../src/bot/rateLimit";
import { retryAfterMs } from "../src/notifier/notifier";

const GROUP = -1001;
const MEMBER = 777;

/** A real grammY client with the limiter, a stand-in Telegram, and a clock we move by hand. */
function setup(opts: { store?: RateStore; dmFails?: boolean } = {}) {
  let clock = 1_800_000_000_000;
  const sent: { method: string; chat: unknown; text?: string; ephemeral?: boolean }[] = [];
  const api = new Api("1:TEST", {
    fetch: (async (url: string, init?: RequestInit) => {
      const method = String(url).split("/").pop()!;
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (opts.dmFails && body.chat_id === MEMBER) return Response.json({ ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" });
      sent.push({ method, chat: body.chat_id, text: body.text, ephemeral: !!body.ephemeral_message_parameters });
      return Response.json({ ok: true, result: { message_id: sent.length, date: 0, chat: { id: body.chat_id, type: "group" } } });
    }) as unknown as typeof fetch,
  });
  api.config.use(chatRateLimit(opts.store ?? memoryStore(), { now: () => clock, sleep: async (ms) => void (clock += ms) }));
  return { api, sent, advance: (ms: number) => void (clock += ms), now: () => clock };
}
const asMember = <T>(fn: () => Promise<T>) => updateUser.run({ userId: MEMBER }, fn);

describe("what is counted", () => {
  test("sends, edits, copies and forwards count; chat actions, deletes and callback answers do not", () => {
    for (const m of ["sendMessage", "sendPhoto", "editMessageText", "editMessageReplyMarkup", "copyMessage", "forwardMessage"]) expect(counts(m)).toBe(true);
    for (const m of ["sendChatAction", "deleteMessage", "answerCallbackQuery", "getMe"]) expect(counts(m)).toBe(false);
  });

  test("groups (negative IDs, @channels) vs private chats", () => {
    expect(chatKind(-1001)).toBe("group");
    expect(chatKind("@channel")).toBe("group");
    expect(chatKind(777)).toBe("private");
    expect(chatKind(undefined)).toBeNull();
  });

  test("the settings: 18 a minute per group, 1 a second per private chat", () => {
    expect(GROUP_LIMIT).toEqual({ max: 18, windowMs: 60_000 });
    expect(PRIVATE_LIMIT).toEqual({ max: 1, windowMs: 1_000 });
  });
});

describe("a busy group", () => {
  test("18 messages go through; the 19th is held back with the wait until a slot frees", async () => {
    const s = setup();
    for (let i = 0; i < 18; i++) await s.api.sendMessage(GROUP, `m${i}`);
    const err = await s.api.sendMessage(GROUP, "m18").catch((e) => e);
    expect(err).toBeInstanceOf(RateLimited);
    expect((err as RateLimited).retryAfterMs).toBe(60_000);
    expect(s.sent.length).toBe(18);
    s.advance(60_000);
    await s.api.sendMessage(GROUP, "later");
    expect(s.sent.length).toBe(19);
  });

  test("edits count against the same budget", async () => {
    const s = setup();
    for (let i = 0; i < 18; i++) await s.api.editMessageText(GROUP, 5, `v${i}`);
    await expect(s.api.sendMessage(GROUP, "x")).rejects.toBeInstanceOf(RateLimited);
  });

  test("other groups are not affected", async () => {
    const s = setup();
    for (let i = 0; i < 18; i++) await s.api.sendMessage(GROUP, `m${i}`);
    await s.api.sendMessage(-2002, "other group");
    expect(s.sent.at(-1)!.chat).toBe(-2002);
  });

  test("a command's plain reply goes to the member by DM, with a note", async () => {
    const s = setup();
    for (let i = 0; i < 18; i++) await s.api.sendMessage(GROUP, `m${i}`);
    await asMember(() => s.api.sendMessage(GROUP, "Group account 0xpot"));
    expect(s.sent.at(-1)).toEqual({ method: "sendMessage", chat: MEMBER, text: `${BUSY_NOTE}\nGroup account 0xpot`, ephemeral: false });
  });

  test("no DM possible (never started the bot): dropped, as RateLimited, nothing in the group", async () => {
    const s = setup({ dmFails: true });
    for (let i = 0; i < 18; i++) await s.api.sendMessage(GROUP, `m${i}`);
    const err = await asMember(() => s.api.sendMessage(GROUP, "reply")).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimited);
    expect(s.sent.length).toBe(18);
  });

  test("a personal (ephemeral) reply is never redirected here: privateReply makes its own DM", async () => {
    const s = setup();
    for (let i = 0; i < 18; i++) await s.api.sendMessage(GROUP, `m${i}`);
    const err = await asMember(() => s.api.sendMessage(GROUP, "link", { ephemeral_message_parameters: { receiver_user_id: MEMBER } })).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimited);
    expect(s.sent.length).toBe(18);
  });

  test("outside a member's update (the notifier): no redirect, the job waits instead", async () => {
    const s = setup();
    for (let i = 0; i < 18; i++) await s.api.sendMessage(GROUP, `m${i}`);
    const err = await s.api.sendMessage(GROUP, "card").catch((e) => e);
    expect(retryAfterMs(err)).toBe(60_000); // the notifier delays the job by this
  });
});

describe("private chats", () => {
  test("about one a second: a short wait is just waited, a second burst message is held back", async () => {
    const s = setup();
    await s.api.sendMessage(MEMBER, "a");
    const t0 = s.now();
    await s.api.sendMessage(MEMBER, "b"); // waits ~1 s (fake clock)
    expect(s.now() - t0).toBe(1_000);
    expect(s.sent.map((m) => m.text)).toEqual(["a", "b"]);
  });
});

describe("if the counter cannot be read", () => {
  test("messages go through (never block everything because Redis is down)", async () => {
    const broken: RateStore = { take: async () => Promise.reject(new Error("redis down")) };
    const s = setup({ store: broken });
    const orig = console.error;
    console.error = () => {};
    try {
      for (let i = 0; i < 25; i++) await s.api.sendMessage(GROUP, `m${i}`);
    } finally {
      console.error = orig;
    }
    expect(s.sent.length).toBe(25);
  });
});

describe("wiring", () => {
  const read = (...p: string[]) => readFileSync(join(import.meta.dir, "..", "src", ...p), "utf8");
  test("installed on the main bot (shared with the notifier), with the member recorded per update", () => {
    const bot = read("bot", "bot.ts");
    expect(bot).toContain("bot.api.config.use(chatRateLimit(redisStore(");
    expect(bot).toContain("bot.use((ctx, next) => updateUser.run({ userId: ctx.from?.id }, next));");
    expect(bot).toContain("if (e instanceof RateLimited) return;");
  });

  test("the Redis counter is one atomic script per call, on a per-chat key", () => {
    const src = read("bot", "rateLimit.ts");
    expect(src).toContain("redis.call('ZREMRANGEBYSCORE', key, '-inf', now - win)");
    expect(src).toContain("`tg-rate:${key}`");
  });
});
