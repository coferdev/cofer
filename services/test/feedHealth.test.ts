import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HttpRequestError, type Address } from "viem";
import { ageText, FEED_WARN_BEFORE_LIMIT_SEC, feedProblems, type FeedNow } from "../src/core/feedHealth";
import { feedHealth, type FeedHealthDeps } from "../src/keeper/keeper";
import type { AlertDeps } from "../src/keeper/alerts";

const H = 3600;
const DAY = 24 * H;
const NOW = 1_800_000_000;
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
const TSLA = "0x322F0929c4625eD5bAd873c95208D54E1c003b2d" as Address;
const feed = (ageSec: number, maxStaleness = DAY, answer = 100_000_000n): FeedNow => ({ answer, updatedAt: NOW - ageSec, maxStaleness });
const open = (ageSec: number, maxStaleness = DAY, answer?: bigint) =>
  feedProblems("USDG", USDG, feed(ageSec, maxStaleness, answer), NOW)
    .filter((p) => p.problem !== null)
    .map((p) => p.key.split(":")[0]);

describe("feed health: when each alert holds", () => {
  test("the setting: warn one hour before the limit", () => {
    expect(FEED_WARN_BEFORE_LIMIT_SEC).toBe(H);
  });

  test("USDG's normal rhythm (21-22h old, 1-day limit) raises nothing", () => {
    for (const age of [0, 21 * H, 22 * H, 22 * H + 59 * 60]) expect(open(age)).toEqual([]);
  });

  test("within the last hour before the limit: an early warning only", () => {
    expect(open(23 * H)).toEqual(["feed-near"]);
    expect(open(DAY)).toEqual(["feed-near"]); // exactly at the limit the contract still accepts it
  });

  test("past the limit: always the stale alert (the warning stays open, so it never reads as cleared)", () => {
    expect(open(DAY + 1)).toEqual(["feed-stale", "feed-near"]);
    expect(open(3 * DAY)).toEqual(["feed-stale", "feed-near"]);
  });

  test("a stock feed over a market weekend (4-day limit) raises nothing", () => {
    expect(open(66 * H, 4 * DAY)).toEqual([]);
  });

  test("a price the contract rejects: zero, negative, or a time in the future", () => {
    expect(open(H, DAY, 0n)).toEqual(["feed-bad"]);
    expect(open(H, DAY, -1n)).toEqual(["feed-bad"]);
    expect(open(-60)).toEqual(["feed-bad"]);
  });

  test("the texts: symbol, age and limit, and exits are never affected", () => {
    const [, stale, near] = feedProblems("USDG", USDG, feed(25 * H + 10 * 60), NOW);
    expect(stale!.problem).toBe("USDG price feed is past its limit (25h 10m old, limit 24h). Deposits and swaps that need it are refused until it updates. Exits are not affected.");
    expect(near!.problem).toBe("USDG price feed is close to its limit (25h 10m old, limit 24h).");
    expect(stale!.key).toBe(`feed-stale:${USDG.toLowerCase()}`);
  });

  test("ageText", () => {
    expect(ageText(40 * 60)).toBe("40m");
    expect(ageText(23 * H)).toBe("23h");
    expect(ageText(DAY)).toBe("24h");
    expect(ageText(47 * H + 59 * 60)).toBe("47h 59m");
    expect(ageText(4 * DAY)).toBe("4d");
    expect(ageText(3 * DAY + 2 * H + 5)).toBe("3d 2h");
    expect(ageText(-5)).toBe("0m");
  });
});

describe("feed health: the keeper job", () => {
  function run(reads: Record<string, () => FeedNow | null>, opened: Map<string, string>) {
    const sent: string[] = [];
    const alerts: AlertDeps = {
      async open(k, t) {
        if (opened.has(k)) return false;
        opened.set(k, t);
        return true;
      },
      async close(k) {
        const t = opened.get(k) ?? null;
        opened.delete(k);
        return t;
      },
      async send(t) {
        sent.push(t);
      },
    };
    const deps: FeedHealthDeps = {
      targets: async () => [
        { symbol: "USDG", asset: USDG },
        { symbol: "TSLA", asset: TSLA },
      ],
      read: async (a) => reads[a]!(),
      alerts,
      now: () => NOW,
    };
    return { sent, done: feedHealth(deps) };
  }

  test("checks USDG and every stock; a stale feed alerts once, then clears when it updates", async () => {
    const opened = new Map<string, string>();
    const r1 = run({ [USDG]: () => feed(25 * H), [TSLA]: () => feed(H, 4 * DAY) }, opened);
    expect(await r1.done).toEqual([
      { asset: "USDG", ageSec: 25 * H },
      { asset: "TSLA", ageSec: H },
    ]);
    expect(r1.sent).toEqual([
      "USDG price feed is past its limit (25h old, limit 24h). Deposits and swaps that need it are refused until it updates. Exits are not affected.",
      "USDG price feed is close to its limit (25h old, limit 24h).",
    ]);

    const r2 = run({ [USDG]: () => feed(25 * H + 15 * 60), [TSLA]: () => feed(H, 4 * DAY) }, opened);
    await r2.done;
    expect(r2.sent).toEqual([]); // still stale: nothing new

    const r3 = run({ [USDG]: () => feed(10 * 60), [TSLA]: () => feed(H, 4 * DAY) }, opened);
    await r3.done;
    expect(r3.sent.every((t) => t.startsWith("Cleared: USDG"))).toBe(true);
    expect(r3.sent.length).toBe(2);
    expect(opened.size).toBe(0);
  });

  test("a chain hiccup neither raises nor clears an alert, and the other feeds are still checked", async () => {
    const opened = new Map<string, string>([[`feed-stale:${USDG.toLowerCase()}`, "USDG stale"]]);
    const r = run(
      {
        [USDG]: () => {
          throw new HttpRequestError({ url: "https://rpc.example/SECRETKEY123", details: "fetch failed" });
        },
        [TSLA]: () => feed(5 * DAY, 4 * DAY),
      },
      opened,
    );
    const origError = console.error;
    console.error = () => {};
    try {
      expect(await r.done).toEqual([{ asset: "TSLA", ageSec: 5 * DAY }]);
    } finally {
      console.error = origError;
    }
    expect(opened.has(`feed-stale:${USDG.toLowerCase()}`)).toBe(true); // not cleared by the failed read
    expect(r.sent.some((t) => t.startsWith("TSLA price feed is past its limit"))).toBe(true);
    expect(r.sent.join(" ")).not.toContain("SECRETKEY123");
  });

  test("an asset with no feed on the factory is skipped", async () => {
    const r = run({ [USDG]: () => feed(H), [TSLA]: () => null }, new Map());
    expect(await r.done).toEqual([{ asset: "USDG", ageSec: H }]);
    expect(r.sent).toEqual([]);
  });

  test("the real job checks USDG plus every listed stock, reading each feed's limit from the factory", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "keeper", "keeper.ts"), "utf8");
    expect(src).toContain('[{ symbol: "USDG", asset: env().USDG_ADDRESS }, ...listed.map(');
    expect(src).toContain('functionName: "assetInfo", args: [asset]');
    expect(src).toContain("maxStaleness: info.maxStaleness");
  });
});
