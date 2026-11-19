import { describe, expect, test } from "bun:test";
import fixtures from "./fixtures/bs-float64.json";
import { parseWad } from "../src/arena/engine/detmath";
import {
  type OptPos, buyOption, expiries, listStrikes, modelPrice, optionValue, quote, sellOption, seriesId, settle, settlementPrice,
} from "../src/arena/engine/options";

const PX = (n: number) => BigInt(Math.round(n * 1e8));
const H = 3_600_000;

describe("arena options", () => {
  test("Black-Scholes on bigint maths matches float64 to within 1e-8 of S (and put-call parity holds)", () => {
    for (const f of fixtures) {
      const S = PX(f.S);
      const K = PX(f.K);
      const sig = parseWad(String(f.sigma));
      const c = modelPrice("CALL", S, K, sig, BigInt(f.secs));
      const p = modelPrice("PUT", S, K, sig, BigInt(f.secs));
      const tol = f.S * 1e-8 + 2e-8;
      expect(Math.abs(Number(c) / 1e8 - f.call)).toBeLessThan(tol);
      expect(Math.abs(Number(p) / 1e8 - f.put)).toBeLessThan(tol);
      // C − P = S − K (r = 0), up to rounding and the payoff floor deep in the money
      const parity = c - p - (S - K);
      expect(parity < 0n ? -parity : parity).toBeLessThanOrEqual(BigInt(Math.ceil(tol * 1e8)) + 4n);
    }
  });

  test("at expiry, or with zero vol, the price is the payoff", () => {
    expect(modelPrice("CALL", PX(101), PX(100), parseWad("0.5"), 0n)).toBe(PX(1));
    expect(modelPrice("PUT", PX(101), PX(100), parseWad("0.5"), 0n)).toBe(0n);
    expect(modelPrice("PUT", PX(99), PX(100), 0n, 3600n)).toBe(PX(1));
  });

  test("ask = model·1.03 + 0.01 chip (rounded up), bid = model·0.97 (rounded down)", () => {
    const q = quote("BTC", "CALL", PX(100_000), PX(100_000), parseWad("0.52"), 3600n, 1n);
    // one BTC contract is 0.01 BTC: model ≈ 221.646 × 0.01 = 2.21646 chips
    expect(Number(q.ask) / 1e6).toBeCloseTo(2.21646 * 1.03 + 0.01, 4);
    expect(Number(q.bid) / 1e6).toBeCloseTo(2.21646 * 0.97, 4);
    expect(q.ask).toBeGreaterThan(q.bid);
  });

  test("strikes: round(M/step)·step + k·step for k = −5..+5", () => {
    expect(listStrikes("BTC", PX(100_260))).toEqual([-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5].map((k) => PX(100_500 + k * 500)));
    expect(listStrikes("NVDA", PX(181.3))[5]).toBe(PX(182.5));
    expect(listStrikes("ETH", PX(60)).every((s) => s > 0n)).toBe(true);
  });

  test("expiries: crypto every hour plus game end; stocks each session close plus game end inside a session", () => {
    const start = Date.parse("2026-11-23T14:20:00Z"); // a Monday
    const c = expiries("BTC", start, start + 3 * H);
    expect(c.map((t) => new Date(t).toISOString().slice(11, 16))).toEqual(["15:00", "16:00", "17:00", "17:20"]);
    // a week: Thanksgiving Thu 26 Nov closed, Fri 27 Nov early close 13:00 ET = 18:00 UTC
    const s = expiries("NVDA", start, Date.parse("2026-11-30T15:00:00Z"));
    expect(s.map((t) => new Date(t).toISOString().slice(0, 16))).toEqual([
      "2026-11-23T21:00", "2026-11-24T21:00", "2026-11-25T21:00", "2026-11-27T18:00", "2026-11-30T15:00",
    ]);
    // game end outside a session is not an expiry for stocks
    expect(expiries("SPY", start, Date.parse("2026-11-24T23:00:00Z")).map((t) => new Date(t).toISOString().slice(0, 16))).toEqual([
      "2026-11-23T21:00", "2026-11-24T21:00",
    ]);
  });

  const series = { sym: "BTC" as const, type: "CALL" as const, strike: PX(100_000), expiry: 1_800_003_600_000, contracts: 10n };
  const listed = new Set([seriesId("BTC", "CALL", PX(100_000), series.expiry)]);
  const now = 1_800_000_000_000;
  const sig = parseWad("0.52");

  test("buy: paid in cash at the ask, only listed series, never in the last 5 minutes, within the premium budget", () => {
    const opts = new Map<string, OptPos>();
    const r = buyOption(opts, 10_000_000_000n, series, PX(100_000), sig, now, 10_000_000_000n, 2_500n, listed);
    expect(r.ok).toBe(true);
    expect(opts.size).toBe(1);
    expect(buyOption(new Map(), 10_000_000_000n, { ...series, strike: PX(1) }, PX(100_000), sig, now, 10_000_000_000n, 2_500n, listed)).toEqual({ ok: false, reason: "MARKET" });
    expect(buyOption(new Map(), 10_000_000_000n, series, PX(100_000), sig, series.expiry - 299_000, 10_000_000_000n, 2_500n, listed)).toEqual({ ok: false, reason: "LATE" });
    // 25% of a 10,000 stack is 2,500 chips: 10,000 contracts (≈ 23,000 chips) is over it
    expect(buyOption(new Map(), 10_000_000_000n, { ...series, contracts: 10_000n }, PX(100_000), sig, now, 10_000_000_000n, 2_500n, listed)).toEqual({ ok: false, reason: "CAP" });
    expect(buyOption(new Map(), 1_000n, series, PX(100_000), sig, now, 10_000_000_000n, 2_500n, listed)).toEqual({ ok: false, reason: "MARGIN" });
  });

  test("buy then sell at once loses the spread (never makes chips); value is at bid", () => {
    const opts = new Map<string, OptPos>();
    const b = buyOption(opts, 10_000_000_000n, series, PX(100_000), sig, now, 10_000_000_000n, 2_500n, listed);
    if (!b.ok) throw new Error();
    const ov = optionValue(opts, new Map([["BTC", PX(100_000)]]), new Map([["BTC", sig]]), now);
    expect(ov).toBeLessThan(b.chips);
    const s = sellOption(opts, seriesId("BTC", "CALL", PX(100_000), series.expiry), 10n, PX(100_000), sig, now);
    expect(s.ok && s.chips).toBe(ov);
    expect(opts.size).toBe(0);
  });

  test("settlement pays the payoff × size to cash, rounded down, and removes the options", () => {
    const opts = new Map<string, OptPos>([[seriesId("BTC", "CALL", PX(100_000), series.expiry), { ...series, premium: 1n }]]);
    // 10 contracts × 0.01 BTC × (101,234.56 − 100,000) = 123.456 chips
    expect(settle(opts, "BTC", series.expiry, PX(101_234.56))).toBe(123_456_000n);
    expect(opts.size).toBe(0);
  });

  test("settlement price: first valid tick within 300 s after τ, else the last valid mark at or before τ", () => {
    const tau = 1_000_000;
    expect(settlementPrice([{ ts: tau - 1000, mark: 5n }, { ts: tau, mark: null }, { ts: tau + 2000, mark: 7n }], tau)).toBe(7n);
    expect(settlementPrice([{ ts: tau - 1000, mark: 5n }, { ts: tau + 301_000, mark: 7n }], tau)).toBe(5n);
  });
});
