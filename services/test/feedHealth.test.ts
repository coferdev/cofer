import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HttpRequestError, type Address } from "viem";
import { ageText, FEED_WARN_BEFORE_LIMIT_SEC, feedProblems, feedWarning, USDG_STALE_ALERT_GRACE_SEC, type FeedNow } from "../src/core/feedHealth";
import { explorerFor } from "../src/chain/addresses";
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

  test("a feed well inside its 1-day limit raises nothing", () => {
    for (const age of [0, 21 * H, 22 * H, 22 * H + 59 * 60]) expect(open(age)).toEqual([]);
  });

  test("within the last hour before the limit: no alert, a log line only", () => {
    expect(open(23 * H)).toEqual([]);
    expect(open(DAY)).toEqual([]); // exactly at the limit the contract still accepts it
    expect(feedWarning("USDG", feed(23 * H), NOW)).toBe("USDG price feed is close to its limit (23h old, limit 24h).");
    expect(feedWarning("USDG", feed(22 * H), NOW)).toBeNull();
    expect(feedWarning("USDG", feed(DAY + 1), NOW)).toBeNull(); // past it: the alert instead
  });

  test("past the limit: the same one alert (one alert per problem)", () => {
    expect(open(DAY + 1)).toEqual(["feed-stale"]);
    expect(open(3 * DAY)).toEqual(["feed-stale"]);
  });

  test("with a grace (USDG: 5 minutes), price-stale holds only once the feed is past its limit by more than the grace", () => {
    expect(USDG_STALE_ALERT_GRACE_SEC).toBe(300);
    const stale = (age: number) => feedProblems("USDG", USDG, feed(age), NOW, USDG_STALE_ALERT_GRACE_SEC).find((p) => p.key.startsWith("feed-stale"))!.problem;
    expect(stale(DAY + 30)).toBeNull(); // the real daily window: 24h plus up to about 30s
    expect(stale(DAY + 300)).toBeNull();
    expect(stale(DAY + 301)).toContain("past its limit");
    // a bad price is never held back by the grace
    expect(feedProblems("USDG", USDG, feed(H, DAY, 0n), NOW, USDG_STALE_ALERT_GRACE_SEC).find((p) => p.key.startsWith("feed-bad"))!.problem).not.toBeNull();
  });

  test("a stock feed over a market weekend (96h limit) raises nothing, even a weekend plus a holiday", () => {
    expect(open(66 * H, 4 * DAY)).toEqual([]);
    expect(open(2.4 * DAY, 4 * DAY)).toEqual([]); // the longest gap seen in 14 days of feed history
  });

  test("a price the contract rejects: zero, negative, or a time in the future", () => {
    expect(open(H, DAY, 0n)).toEqual(["feed-bad"]);
    expect(open(H, DAY, -1n)).toEqual(["feed-bad"]);
    expect(open(-60)).toEqual(["feed-bad"]);
  });

  test("the texts: symbol, age and limit, and exits are never affected", () => {
    const [bad, stale] = feedProblems("USDG", USDG, feed(25 * H + 10 * 60), NOW);
    expect(stale!.problem).toBe("USDG price feed is past its limit (25h 10m old, limit 24h). Deposits and swaps that need it are refused until it updates. Exits are not affected.");
    expect(stale!.key).toBe(`feed-stale:${USDG.toLowerCase()}`);
    expect([bad!.name, stale!.name]).toEqual(["price-bad-USDG", "price-stale-USDG"]);
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
      "[cofer alert] price-stale-USDG\nUSDG price feed is past its limit (25h old, limit 24h). Deposits and swaps that need it are refused until it updates. Exits are not affected.\nWho acts: Dev checks.",
    ]);

    const r2 = run({ [USDG]: () => feed(25 * H + 15 * 60), [TSLA]: () => feed(H, 4 * DAY) }, opened);
    await r2.done;
    expect(r2.sent).toEqual([]); // still stale: nothing new

    const r3 = run({ [USDG]: () => feed(10 * 60), [TSLA]: () => feed(H, 4 * DAY) }, opened);
    await r3.done;
    expect(r3.sent).toEqual(["[cofer alert] price-stale-USDG: Cleared."]);
    expect(opened.size).toBe(0);
  });

  test("USDG in its daily update window is not posted; more than 5 minutes past its limit is", async () => {
    const opened = new Map<string, string>();
    const r1 = run({ [USDG]: () => feed(DAY + 30), [TSLA]: () => feed(H, 4 * DAY) }, opened);
    await r1.done;
    expect(r1.sent).toEqual([]);
    expect(opened.size).toBe(0);

    const r2 = run({ [USDG]: () => feed(DAY + 5 * 60 + 1), [TSLA]: () => feed(H, 4 * DAY) }, opened);
    await r2.done;
    expect(r2.sent).toEqual([
      "[cofer alert] price-stale-USDG\nUSDG price feed is past its limit (24h 5m old, limit 24h). Deposits and swaps that need it are refused until it updates. Exits are not affected.\nWho acts: Dev checks.",
    ]);
  });

  test("a stock gets no grace: past its limit by 30 seconds is posted", async () => {
    const opened = new Map<string, string>();
    const r = run({ [USDG]: () => feed(H), [TSLA]: () => feed(4 * DAY + 30, 4 * DAY) }, opened);
    await r.done;
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]).toStartWith("[cofer alert] price-stale-TSLA\n");
  });

  test("close to the limit: written to the log, never posted", async () => {
    const logged: string[] = [];
    const sent: string[] = [];
    const alerts = { open: async () => true, close: async () => null, send: async (t: string) => void sent.push(t) };
    await feedHealth({ targets: async () => [{ symbol: "USDG", asset: USDG }], read: async () => feed(23 * H + 30 * 60), alerts, now: () => NOW, log: (t) => void logged.push(t) });
    expect(sent).toEqual([]);
    expect(logged).toEqual(["USDG price feed is close to its limit (23h 30m old, limit 24h)."]);
  });

  test("an old separate 'close to its limit' warning left open is dropped without a post", async () => {
    const opened = new Map<string, string>([[`feed-near:${USDG.toLowerCase()}`, "USDG price feed is close to its limit."]]);
    const r = run({ [USDG]: () => feed(H), [TSLA]: () => feed(H, 4 * DAY) }, opened);
    await r.done;
    expect(opened.size).toBe(0);
    expect(r.sent).toEqual([]);
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
    expect(r.sent.some((t) => t.startsWith("[cofer alert] price-stale-TSLA\nTSLA price feed is past its limit"))).toBe(true);
    expect(r.sent.join(" ")).not.toContain("SECRETKEY123");
  });

  test("an asset with no feed on the factory is skipped", async () => {
    const r = run({ [USDG]: () => feed(H), [TSLA]: () => null }, new Map());
    expect(await r.done).toEqual([{ asset: "USDG", ageSec: H }]);
    expect(r.sent).toEqual([]);
  });

  test("explorer links: the known explorer for each chain, unless overridden", () => {
    expect(explorerFor(4663)).toBe("https://robinhoodchain.blockscout.com");
    expect(explorerFor(46630)).toBe("https://explorer.testnet.chain.robinhood.com");
    expect(explorerFor(1)).toBeUndefined();
    expect(explorerFor(4663, "https://other.example")).toBe("https://other.example");
  });

  test("the real job checks USDG plus every listed stock, reading each feed's limit from the factory", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "keeper", "keeper.ts"), "utf8");
    expect(src).toContain('[{ symbol: "USDG", asset: env().USDG_ADDRESS }, ...listed.map(');
    expect(src).toContain('functionName: "assetInfo", args: [asset]');
    expect(src).toContain("maxStaleness: info.maxStaleness");
  });
});
