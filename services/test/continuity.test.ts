import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HttpRequestError, type Address } from "viem";
import {
  CONTINUITY_ACCEPT_AFTER_SEC,
  CONTINUITY_JUMP_BPS,
  CONTINUITY_SPLIT_TOLERANCE_BPS,
  CORPORATE_ACTION_BPS,
  PENDING_WINDOW_SEC,
  multiplierText,
  pendingFrom,
  type Pending,
  type Reading,
} from "../src/core/continuity";
import { multiplierContinuity, type ContinuityDeps } from "../src/keeper/keeper";
import type { AlertDeps } from "../src/keeper/alerts";

const ONE = 10n ** 18n;
const H = 3600;
const T0 = 1_800_000_000;
const TICK = 15 * 60;
const TSLA = "0x322F0929c4625eD5bAd873c95208D54E1c003b2d" as Address;
const KEY = `continuity:${TSLA.toLowerCase()}`;

/**
 * The keeper's 15-minute feed job against a scripted chain: each step is what the feed and the
 * token report at that tick (null = the read fails). Returns every alert line sent, in order.
 */
async function replay(steps: (Partial<Reading> & { feedTime?: number } | null)[], pending: Pending | null = null) {
  let chain: Reading = { answer: 250_00000000n, updatedAt: T0, multiplier: ONE };
  let clock = T0;
  let stored: { base: Reading; mismatchSince: number | null } | null = null;
  const open = new Map<string, string>();
  const sent: string[] = [];
  const alerts: AlertDeps = {
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
      sent.push(t);
    },
  };
  let failNext = false;
  const deps: ContinuityDeps = {
    targets: async () => [{ symbol: "TSLA", asset: TSLA, pending }],
    read: async () => {
      if (failNext) throw new HttpRequestError({ url: "https://rpc.example/SECRETKEY123", details: "fetch failed" });
      return chain;
    },
    load: async () => stored,
    save: async (_a, base, mismatchSince) => {
      stored = { base, mismatchSince };
    },
    alerts,
    now: () => clock,
  };
  const quiet = console.error;
  console.error = () => {};
  try {
    await multiplierContinuity(deps); // first reading: the base
    for (const s of steps) {
      clock += TICK;
      failNext = s === null;
      if (s) chain = { answer: s.answer ?? chain.answer, multiplier: s.multiplier ?? chain.multiplier, updatedAt: s.feedTime ?? (s.answer !== undefined ? clock : chain.updatedAt) };
      await multiplierContinuity(deps);
    }
  } finally {
    console.error = quiet;
  }
  return { sent, open, stored: stored as { base: Reading; mismatchSince: number | null } | null, clock: () => clock };
}

describe("multiplier continuity alert (M8 gate)", () => {
  test("the settings", () => {
    expect([CONTINUITY_JUMP_BPS, CONTINUITY_SPLIT_TOLERANCE_BPS, CORPORATE_ACTION_BPS]).toEqual([3500, 1500, 500]);
    expect([PENDING_WINDOW_SEC, CONTINUITY_ACCEPT_AFTER_SEC]).toEqual([6 * H, 24 * H]);
  });

  test("a clean 2-for-1 split: the multiplier changes, the feed pauses, then doubles. No alert", async () => {
    const r = await replay([{ multiplier: 2n * ONE }, {}, {}, { answer: 500_00000000n }, { answer: 505_00000000n }]);
    expect(r.sent).toEqual([]);
    expect(r.stored!.base.multiplier).toBe(2n * ONE);
  });

  test("FIRES: the multiplier doubles but the feed price does not move", async () => {
    const r = await replay([{ multiplier: 2n * ONE }, { answer: 252_00000000n }]);
    expect(r.sent).toEqual([
      "TSLA: the multiplier changed 1 → 2 (expected about 2.00×) but the price feed moved 1.01×. Values for TSLA may be wrong (a split counted twice or not at all). Check before trusting them.",
    ]);
    expect(r.open.has(KEY)).toBe(true);
  });

  test("FIRES: the feed doubles with no multiplier change and nothing announced", async () => {
    const r = await replay([{ answer: 500_00000000n }]);
    expect(r.sent).toEqual([
      "TSLA: the price feed moved 2.00× but the token's multiplier did not change. Values for TSLA may be wrong (a split counted twice or not at all). Check before trusting them.",
    ]);
  });

  test("FIRES: the split is counted twice (multiplier 2, feed 4x)", async () => {
    const r = await replay([{ multiplier: 2n * ONE, answer: 1000_00000000n }]);
    expect(r.sent.length).toBe(1);
    expect(r.sent[0]).toContain("moved 4.00×");
  });

  test("FIRES: a 3-for-2 split the feed never applied (a 33% gap is caught by the tighter split tolerance)", async () => {
    const r = await replay([{ multiplier: (3n * ONE) / 2n, answer: 251_00000000n }]);
    expect(r.sent.length).toBe(1);
    expect(r.sent[0]).toContain("the multiplier changed 1 → 1.5 (expected about 1.50×)");
  });

  test("an announced split where the feed moves first: wait for the token, no alert", async () => {
    const pending = { multiplier: 2n * ONE, effectiveAt: T0 + H };
    const r = await replay([{ answer: 500_00000000n }, { answer: 501_00000000n }, { multiplier: 2n * ONE }, { answer: 502_00000000n }], pending);
    expect(r.sent).toEqual([]);
    expect(r.stored!.base).toMatchObject({ multiplier: 2n * ONE, answer: 502_00000000n });
  });

  test("FIRES: the announced split's window has passed and the token still has the old multiplier", async () => {
    const pending = { multiplier: 2n * ONE, effectiveAt: T0 - PENDING_WINDOW_SEC };
    const r = await replay([{ answer: 500_00000000n }], pending);
    expect(r.sent.length).toBe(1);
  });

  test("dividend-sized multiplier drift (like NVDA 1.00078) with a normal 20% day: no alert; a 40% jump: alert", async () => {
    const drift = 1_000_775_159_164_630_595n;
    expect((await replay([{ multiplier: drift, answer: 300_00000000n }])).sent).toEqual([]);
    expect((await replay([{ multiplier: drift, answer: 350_00000000n }])).sent.length).toBe(1);
  });

  test("an open alert is not repeated, and clears once the multiplier catches up", async () => {
    const r = await replay([{ answer: 500_00000000n }, { answer: 501_00000000n }, {}, { multiplier: 2n * ONE }, { answer: 503_00000000n }]);
    expect(r.sent.length).toBe(2);
    expect(r.sent[1]).toStartWith("Cleared: TSLA: the price feed moved 2.00×");
    expect(r.open.size).toBe(0);
  });

  test("an unexplained level that holds 24h is accepted as the new normal, with a note and a clear", async () => {
    const ticks = CONTINUITY_ACCEPT_AFTER_SEC / TICK;
    const steps = [{ answer: 140_00000000n }, ...Array.from({ length: ticks }, (_, i) => ({ answer: 140_00000000n + BigInt(i + 1) }))];
    const r = await replay(steps);
    expect(r.sent.length).toBe(3);
    expect(r.sent[1]).toBe("TSLA: the new price level has held for 24h, so it is now treated as normal. If TSLA had no corporate action, this was a large market move.");
    expect(r.sent[2]).toStartWith("Cleared: TSLA: the price feed moved 0.56×");
    expect(r.stored!.mismatchSince).toBeNull();
  });

  test("a failed chain read changes nothing: no alert raised or cleared, the base is kept", async () => {
    const r = await replay([{ answer: 500_00000000n }, null, null]);
    expect(r.sent.length).toBe(1);
    expect(r.open.has(KEY)).toBe(true);
    expect(r.stored!.base.answer).toBe(250_00000000n);
    expect(r.sent.join(" ")).not.toContain("SECRETKEY123");
  });

  test("normal days: small moves never alert", async () => {
    const r = await replay([{ answer: 255_00000000n }, { answer: 240_00000000n }, {}, { answer: 260_00000000n }]);
    expect(r.sent).toEqual([]);
  });
});

describe("continuity helpers and wiring", () => {
  test("multiplier text and the issuer's pending multiplier", () => {
    expect(multiplierText(ONE)).toBe("1");
    expect(multiplierText(2n * ONE)).toBe("2");
    expect(multiplierText(1_000_775_159_164_630_595n)).toBe("1.0008");
    expect(pendingFrom("2.000000000000000000", new Date((T0 + H) * 1000))).toEqual({ multiplier: 2n * ONE, effectiveAt: T0 + H });
    expect(pendingFrom(null, new Date())).toBeNull();
    expect(pendingFrom("2.0", null)).toBeNull();
  });

  test("the 15-minute feed job runs it, reading the feed and the token's own multiplier together", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "keeper", "keeper.ts"), "utf8");
    expect(src).toContain("return { feeds: await feedHealth(), continuity: await multiplierContinuity() };");
    expect(src).toContain('client.readContract({ address: asset, abi: erc20Abi, functionName: "uiMultiplier" })');
    expect(src).toContain("eq(schema.assets.isStock, true)");
  });

  test("migration 0002 adds only the feed_readings table", () => {
    const sql = readFileSync(join(import.meta.dir, "..", "drizzle", "0002_feed_readings.sql"), "utf8");
    expect(sql).toContain('CREATE TABLE "feed_readings"');
    expect(sql.match(/CREATE|ALTER|DROP/g)).toEqual(["CREATE"]);
  });
});
