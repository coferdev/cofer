import { describe, expect, spyOn, test } from "bun:test";
import { alertBotSender, checkAlert, deliver, type AlertDeps } from "../src/keeper/alerts";
import { parseEnv } from "../src/env";

const TOKEN = "7000000001:AAFakeAlertBotTokenSECRETxyz";
const CHAT = 123456789;

/** Captures everything written to the log while `fn` runs. */
async function logs(fn: () => Promise<unknown>): Promise<string> {
  const err = spyOn(console, "error").mockImplementation(() => {});
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await fn().catch(() => {});
    return [...err.mock.calls, ...warn.mock.calls].map((c) => c.map(String).join(" ")).join("\n");
  } finally {
    err.mockRestore();
    warn.mockRestore();
  }
}

/** A stand-in for Telegram: records each request and answers with `reply`. */
function fakeTelegram(reply: () => Response | Promise<Response>) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return reply();
  }) as typeof fetch;
  return { calls, f };
}
const ok = () => Response.json({ ok: true, result: { message_id: 1, date: 0, chat: { id: CHAT, type: "private" } } });

describe("where an alert goes", () => {
  test("no OPS_CHAT_ID: the log only", async () => {
    const sent: string[] = [];
    const out = await logs(() => deliver("USDG feed stale", { botSend: async (_c, t) => void sent.push(t), enqueue: async (_c, t) => void sent.push(t) }));
    expect(out).toContain("[alert] USDG feed stale");
    expect(sent).toEqual([]);
  });

  test("with an alerts bot: through that bot, not the main bot's queue", async () => {
    const bot: string[] = [];
    const queue: string[] = [];
    await logs(() => deliver("USDG feed stale", { chat: CHAT, botSend: async (_c, t) => void bot.push(t), enqueue: async (_c, t) => void queue.push(t) }));
    expect(bot).toEqual(["Cofer alert: USDG feed stale"]);
    expect(queue).toEqual([]);
  });

  test("without an alerts bot: today's behaviour, the notifier queue", async () => {
    const queue: [number, string][] = [];
    await logs(() => deliver("USDG feed stale", { chat: CHAT, enqueue: async (c, t) => void queue.push([c, t]) }));
    expect(queue).toEqual([[CHAT, "Cofer alert: USDG feed stale"]]);
  });
});

describe("the alerts bot", () => {
  test("sends one message to the ops chat", async () => {
    const tg = fakeTelegram(ok);
    await alertBotSender(TOKEN, tg.f)(CHAT, "Cofer alert: hello");
    expect(tg.calls.length).toBe(1);
    expect(tg.calls[0]!.url).toEndWith("/sendMessage");
    expect(tg.calls[0]!.body).toMatchObject({ chat_id: CHAT, text: "Cofer alert: hello" });
  });

  test("Telegram refuses (Start not pressed): Telegram's reason, never the token", async () => {
    const tg = fakeTelegram(() => Response.json({ ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" }, { status: 403 }));
    let msg = "";
    const out = await logs(async () => {
      try {
        await alertBotSender(TOKEN, tg.f)(CHAT, "x");
      } catch (e) {
        msg = (e as Error).message;
        throw e;
      }
    });
    expect(msg).toBe("alerts bot: Telegram said 403 Forbidden: bot can't initiate conversation with a user");
    expect(`${msg}${out}`).not.toContain("SECRET");
  });

  test("Telegram unreachable, with the token in the network error: a fixed message, no cause, no token", async () => {
    const tg = fakeTelegram(() => {
      throw new Error(`connect ECONNREFUSED https://api.telegram.org/bot${TOKEN}/sendMessage (bot${TOKEN})`);
    });
    let err: Error | undefined;
    try {
      await alertBotSender(TOKEN, tg.f)(CHAT, "x");
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).toBe("alerts bot: could not reach Telegram");
    expect(err?.cause).toBeUndefined();
    expect(`${err?.message}${err?.stack}`).not.toContain("SECRET");
  });

  test("end to end: a failed alerts-bot send logs no token, and the alert is retried on the next run", async () => {
    const open = new Map<string, string>();
    let up = false;
    const tg = fakeTelegram(() => {
      if (!up) throw new Error(`fetch failed for https://api.telegram.org/bot${TOKEN}/sendMessage`);
      return ok();
    });
    const send = alertBotSender(TOKEN, tg.f);
    const deps: AlertDeps = {
      async open(k, t) {
        if (open.has(k)) return false;
        open.set(k, t);
        return true;
      },
      async close(k) {
        const t = open.get(k) ?? null;
        open.delete(k);
        return t;
      },
      send: (t) => deliver(t, { chat: CHAT, botSend: send, enqueue: async () => {} }),
    };
    let first: unknown;
    const out = await logs(async () => {
      first = await checkAlert("feed-stale:usdg", "USDG feed stale", deps);
    });
    expect(first).toBeNull(); // not delivered...
    expect(open.size).toBe(0); // ...so not recorded as sent
    expect(out).toContain("alerts bot: could not reach Telegram");
    expect(out).not.toContain("SECRET");
    expect(out).not.toContain("7000000001");

    up = true;
    await logs(async () => expect(await checkAlert("feed-stale:usdg", "USDG feed stale", deps)).toBe("opened"));
    expect(tg.calls.at(-1)!.body).toMatchObject({ text: "Cofer alert: USDG feed stale" });
  });
});

describe("a failed delivery is tried again", () => {
  function deps(failSends: number) {
    const open = new Map<string, string>();
    const sent: string[] = [];
    let fails = failSends;
    const d: AlertDeps = {
      async open(k, t) {
        if (open.has(k)) return false;
        open.set(k, t);
        return true;
      },
      async close(k) {
        const t = open.get(k) ?? null;
        open.delete(k);
        return t;
      },
      async send(t) {
        if (fails-- > 0) throw new Error("down");
        sent.push(t);
      },
    };
    return { d, open, sent };
  }

  test("an alert that could not be sent is sent on the next run", async () => {
    const { d, sent } = deps(1);
    await logs(async () => expect(await checkAlert("k", "problem", d)).toBeNull());
    expect(await checkAlert("k", "problem", d)).toBe("opened");
    expect(sent).toEqual(["problem"]);
  });

  test("a 'cleared' that could not be sent stays open and is sent on the next run", async () => {
    const { d, open, sent } = deps(0);
    await checkAlert("k", "problem", d);
    let fail = true;
    const flaky: AlertDeps = { ...d, send: async (t) => (fail ? ((fail = false), Promise.reject(new Error("down"))) : d.send(t)) };
    await logs(async () => expect(await checkAlert("k", null, flaky)).toBeNull());
    expect(open.get("k")).toBe("problem");
    expect(await checkAlert("k", null, flaky)).toBe("cleared");
    expect(sent).toEqual(["problem", "Cleared: problem"]);
  });
});

describe("ALERT_BOT_TOKEN setting", () => {
  test("optional", () => {
    const base = {
      PUBLIC_URL: "https://sign.example",
      DATABASE_URL: "postgres://x",
      RHC_RPC_URL: "https://rpc.example",
      FACTORY_ADDRESS: `0x${"1".repeat(40)}`,
      ADAPTER_ADDRESS: `0x${"2".repeat(40)}`,
      RELAYER_PRIVATE_KEY: "0x01",
      TELEGRAM_BOT_TOKEN: "t",
      TELEGRAM_BOT_USERNAME: "b",
      TELEGRAM_WEBHOOK_SECRET: "s".repeat(16),
      LINK_SECRET: "l".repeat(32),
    };
    expect(parseEnv(base).ALERT_BOT_TOKEN).toBeUndefined();
    expect(parseEnv({ ...base, ALERT_BOT_TOKEN: TOKEN }).ALERT_BOT_TOKEN).toBe(TOKEN);
  });
});
