import { describe, expect, test } from "bun:test";
import {
  eliminate, equity, fillPerp, freeMargin, newSeat, notionalDown, shouldEliminate, spotBuy, spotSell, totalMaintenance,
} from "../src/arena/engine/ledger";

const px = (n: number) => BigInt(Math.round(n * 1e8));
const qty = (n: number) => BigInt(Math.round(n * 1e8));
const chips = (n: number) => BigInt(Math.round(n * 1e6));
const FEE = 5n; // 5 bps
const marks = (btc: number) => new Map([["BTC", px(btc)]]);

describe("perps", () => {
  test("open, mark up, close: cash = stack + profit - two fees", () => {
    const s = newSeat(chips(10_000));
    const m = marks(60_000);
    expect(fillPerp(s, "BTC", qty(0.1), px(60_000), 5n, FEE, m, 10n).ok).toBe(true); // 6,000 notional, fee 3
    expect(s.cash).toBe(chips(9_997));
    expect(freeMargin(s, m)).toBe(chips(9_997 - 1_200));
    const up = marks(61_000);
    expect(equity(s, up)).toBe(chips(9_997 + 100));
    fillPerp(s, "BTC", -qty(0.1), px(61_000), 5n, FEE, up, 10n); // fee 3.05
    expect(s.perps.size).toBe(0);
    expect(s.cash).toBe(chips(10_000 + 100 - 3 - 3.05));
  });
  test("increase averages the entry against the player; partial reduce keeps the entry", () => {
    const s = newSeat(chips(10_000));
    fillPerp(s, "BTC", qty(0.1), px(60_000), 2n, 0n, marks(60_000), 10n);
    fillPerp(s, "BTC", qty(0.2), px(60_001), 2n, 0n, marks(60_001), 10n);
    expect(s.perps.get("BTC")!.entry).toBe(px(60_000) + (2n * 100_000_000n + 2n) / 3n); // ceil for a long
    fillPerp(s, "BTC", -qty(0.1), px(60_100), 2n, 0n, marks(60_100), 10n);
    expect(s.perps.get("BTC")!.q).toBe(qty(0.2));
  });
  test("reverse = close to zero, then open the rest", () => {
    const s = newSeat(chips(10_000));
    fillPerp(s, "BTC", qty(0.1), px(60_000), 5n, 0n, marks(60_000), 10n);
    fillPerp(s, "BTC", -qty(0.3), px(59_000), 3n, 0n, marks(59_000), 10n);
    const p = s.perps.get("BTC")!;
    expect(p.q).toBe(-qty(0.2));
    expect(p.entry).toBe(px(59_000));
    expect(p.lev).toBe(3n);
    expect(s.cash).toBe(chips(10_000 - 100));
  });
  test("refuses over the leverage cap and over free margin", () => {
    const s = newSeat(chips(1_000));
    expect(fillPerp(s, "BTC", qty(0.1), px(60_000), 11n, 0n, marks(60_000), 10n)).toEqual({ ok: false, reason: "CAP" });
    expect(fillPerp(s, "BTC", qty(1), px(60_000), 10n, 0n, marks(60_000), 10n)).toEqual({ ok: false, reason: "MARGIN" });
  });
  test("elimination: E <= maintenance; positions close at the mark; equity floors at 0", () => {
    const s = newSeat(chips(1_000));
    fillPerp(s, "BTC", qty(0.1), px(60_000), 10n, 0n, marks(60_000), 10n); // 600 margin, MM 300 at 60k
    expect(shouldEliminate(s, marks(57_000))).toBe(false); // E 700 > MM 285
    const crash = marks(50_000); // E = 1000 - 1000 = 0 <= MM
    expect(shouldEliminate(s, crash)).toBe(true);
    expect(totalMaintenance(s, crash)).toBe(chips(250));
    eliminate(s, marks(49_000), 123);
    expect(s.cash).toBe(0n);
    expect(s.eliminatedAt).toBe(123);
    expect(fillPerp(s, "BTC", qty(0.01), px(49_000), 2n, 0n, marks(49_000), 10n)).toEqual({ ok: false, reason: "ELIMINATED" });
  });
});

describe("spot and rounding", () => {
  test("buy and sell, long only", () => {
    const s = newSeat(chips(1_000));
    expect(spotBuy(s, "BTC", qty(0.01), px(60_000), FEE).ok).toBe(true);
    expect(s.cash).toBe(chips(1_000 - 600 - 0.3));
    expect(spotSell(s, "BTC", qty(0.02), px(60_000), FEE)).toEqual({ ok: false, reason: "QTY" });
    spotSell(s, "BTC", qty(0.01), px(61_000), FEE);
    expect(s.cash).toBe(chips(1_000 - 600 - 0.3 + 610 - 0.305));
  });
  test("rounding never creates chips: 1,000 tiny round trips never gain", () => {
    const s = newSeat(chips(10_000));
    for (let i = 0; i < 1_000; i++) {
      const p = px(60_000) + BigInt(i % 7);
      fillPerp(s, "BTC", 3n, p, 1n, 0n, new Map([["BTC", p]]), 10n);
      fillPerp(s, "BTC", -3n, p, 1n, 0n, new Map([["BTC", p]]), 10n);
    }
    expect(s.cash <= chips(10_000)).toBe(true);
    expect(notionalDown(1n, 1n)).toBe(0n);
  });
});
