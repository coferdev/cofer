import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkAlert, type AlertDeps } from "../src/keeper/alerts";
import { alertText, WHO, type AlertMessage } from "../src/core/alertFormat";

const msg = (name: string, what: string): AlertMessage => ({ name, what, who: WHO.dev });
import { logAlert } from "../src/core/errors";
import { parseEnv } from "../src/env";

/** The alert store and delivery, in memory. */
function fakeDeps() {
  const open = new Map<string, string>();
  const sent: string[] = [];
  const deps: AlertDeps = {
    async open(key, text) {
      if (open.has(key)) return false;
      open.set(key, text);
      return true;
    },
    async close(key) {
      const t = open.get(key) ?? null;
      open.delete(key);
      return t;
    },
    async send(text) {
      sent.push(text);
    },
  };
  return { deps, open, sent };
}

describe("alerts: once when a problem starts, once when it clears", () => {
  test("a problem seen on several keeper runs sends one alert, then one 'cleared'", async () => {
    const { deps, sent } = fakeDeps();
    const m = msg("price-stale-USDG", "USDG price feed is past its limit (25h old, limit 24h).");
    expect(await checkAlert("feed-stale:usdg", m, deps)).toBe("opened");
    expect(await checkAlert("feed-stale:usdg", m, deps)).toBeNull();
    expect(await checkAlert("feed-stale:usdg", m, deps)).toBeNull();
    expect(await checkAlert("feed-stale:usdg", null, deps)).toBe("cleared");
    expect(await checkAlert("feed-stale:usdg", null, deps)).toBeNull();
    expect(sent).toEqual([
      "[cofer alert] price-stale-USDG\nUSDG price feed is past its limit (25h old, limit 24h).\nWho acts: Dev checks.",
      "[cofer alert] price-stale-USDG: Cleared.",
    ]);
  });

  test("nothing wrong and nothing open: nothing sent", async () => {
    const { deps, sent } = fakeDeps();
    expect(await checkAlert("feed-stale:tsla", null, deps)).toBeNull();
    expect(sent).toEqual([]);
  });

  test("separate problems are tracked separately", async () => {
    const { deps, sent, open } = fakeDeps();
    await checkAlert("feed-stale:tsla", msg("price-stale-TSLA", "TSLA stale."), deps);
    await checkAlert("feed-stale:nvda", msg("price-stale-NVDA", "NVDA stale."), deps);
    await checkAlert("feed-stale:tsla", null, deps);
    expect([...open.keys()]).toEqual(["feed-stale:nvda"]);
    expect(sent).toEqual([alertText(msg("price-stale-TSLA", "TSLA stale.")), alertText(msg("price-stale-NVDA", "NVDA stale.")), "[cofer alert] price-stale-TSLA: Cleared."]);
  });

  test("the message is built by the deps' formatter (the real one names known addresses)", async () => {
    const { deps, sent } = fakeDeps();
    deps.format = (m) => `formatted ${m.name}`;
    await checkAlert("k", msg("indexer-behind", "x"), deps);
    expect(sent).toEqual(["formatted indexer-behind"]);
  });

  test("an alert stored before this format clears under a short form of its key, with no full address", async () => {
    const { deps, open, sent } = fakeDeps();
    open.set("feed-stale:0x5fc5360d0400a0fd4f2af552add042d716f1d168", "USDG price feed is past its limit.");
    await checkAlert("feed-stale:0x5fc5360d0400a0fd4f2af552add042d716f1d168", null, deps);
    expect(sent).toEqual(["[cofer alert] feed-stale:0x5fc5…d168: Cleared."]);
  });
});

describe("alerts: where they go", () => {
  test("the log line never holds a URL", () => {
    const spy = spyOn(console, "warn").mockImplementation(() => {});
    logAlert("feed read failed at https://rpc.example/SECRETKEY123");
    const printed = spy.mock.calls.flat().join(" ");
    spy.mockRestore();
    expect(printed).toContain("[alert]");
    expect(printed).not.toContain("SECRETKEY123");
  });

  test("the ops chat is only used when OPS_CHAT_ID is set, and never a group chat", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "keeper", "alerts.ts"), "utf8");
    expect(src).toContain("send: (text) => deliver(text, { chat: env().OPS_CHAT_ID, botSend: botSend(), enqueue: enqueueChatMessage }),");
    expect(src.match(/enqueueChatMessage/g)?.length).toBe(2); // the import and that one line
  });

  test("OPS_CHAT_ID is optional and must be a number", () => {
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
    expect(parseEnv(base).OPS_CHAT_ID).toBeUndefined();
    expect(parseEnv({ ...base, OPS_CHAT_ID: "123456789" }).OPS_CHAT_ID).toBe(123456789);
    expect(() => parseEnv({ ...base, OPS_CHAT_ID: "@me" })).toThrow();
  });
});

describe("/chatid", () => {
  test("answers only in a private chat, shows only that chat's ID, and is not in /help", () => {
    const bot = readFileSync(join(import.meta.dir, "..", "src", "bot", "bot.ts"), "utf8");
    const cmd = bot.slice(bot.indexOf('bot.command("chatid"'), bot.indexOf('bot.command("region"'));
    expect(cmd).toContain('if (ctx.chat.type !== "private") return;');
    expect(cmd).not.toMatch(/env\(\)|TOKEN|SECRET|RPC/);
    const help = bot.slice(bot.indexOf('bot.command("help"'));
    expect(help).not.toContain("/chatid");
  });
});

describe("migration", () => {
  test("0001 adds only the alerts table", () => {
    const sql = readFileSync(join(import.meta.dir, "..", "drizzle", "0001_alerts.sql"), "utf8");
    expect(sql).toContain('CREATE TABLE "alerts"');
    expect(sql.match(/CREATE|ALTER|DROP/g)).toEqual(["CREATE"]);
  });
});
