import { describe, expect, test } from "bun:test";
import { type MinuteSample, type SeatTrace, detect, pairMetrics } from "../src/arena/scoring/collusion";

const M = 60_000;
const C = 1_000_000n;
const s = (min: number, equity: bigint, x: Record<string, bigint>): MinuteSample => ({ ts: min * M, equity, x: new Map(Object.entries(x)) });

describe("arena collusion", () => {
  test("the one-shot attack: max long vs max short, one eliminated in minutes holding it, is flagged", () => {
    const a: SeatTrace = {
      seat: "a", opens: [{ ts: 10_000, symbol: "ETH", sign: 1 }], eliminatedAt: 3 * M + 5_000, heldAtElimination: new Map([["ETH", 90_000n * C]]),
      samples: [s(0, 10_000n * C, { ETH: 100_000n * C }), s(1, 7_000n * C, { ETH: 97_000n * C }), s(2, 4_000n * C, { ETH: 94_000n * C }), s(3, 1_000n * C, { ETH: 91_000n * C })],
    };
    const b: SeatTrace = {
      seat: "b", opens: [{ ts: 40_000, symbol: "ETH", sign: -1 }], eliminatedAt: null,
      samples: [s(0, 10_000n * C, { ETH: -100_000n * C }), s(1, 13_000n * C, { ETH: -97_000n * C }), s(2, 16_000n * C, { ETH: -94_000n * C }), s(3, 19_000n * C, { ETH: -91_000n * C }), s(4, 19_500n * C, { ETH: -90_000n * C })],
    };
    const m = pairMetrics(a, b);
    expect(m.oBps).toBe(10_000n);
    expect(m.rhoBps).toBeNull(); // 3 shared changes < 5: ρ counts as met
    expect(m.sync).toBe(1);
    expect(m.eliminatedHolding).toBe(true);
    expect(m.flagged).toBe(true);
  });

  test("two honest players who disagree once on ETH, uncorrelated equity, are not flagged", () => {
    const eq = [0, 30, -10, 25, -40, 60, 10, -5, 35, -20];
    const eq2 = [0, 20, 15, -30, -10, 40, 5, 30, -25, 10];
    const a: SeatTrace = { seat: "a", opens: [{ ts: 0, symbol: "ETH", sign: 1 }], eliminatedAt: null, samples: eq.map((e, k) => s(k, (10_000n + BigInt(e)) * C, { ETH: 5_000n * C, BTC: 5_000n * C })) };
    const b: SeatTrace = { seat: "b", opens: [{ ts: 30_000, symbol: "ETH", sign: -1 }], eliminatedAt: null, samples: eq2.map((e, k) => s(k, (10_000n + BigInt(e)) * C, { ETH: -5_000n * C, BTC: 5_000n * C })) };
    const m = pairMetrics(a, b);
    expect(m.oBps).toBe(5_000n); // half the exposure opposed
    expect(m.flagged).toBe(false);
  });

  test("ρ is computed in integers: a mirror image is −1", () => {
    const e = [0, 10, -20, 35, 5, -15, 40];
    const a: SeatTrace = { seat: "a", opens: [], eliminatedAt: null, samples: e.map((v, k) => s(k, BigInt(10_000 + v) * C, { BTC: 1n })) };
    const b: SeatTrace = { seat: "b", opens: [], eliminatedAt: null, samples: e.map((v, k) => s(k, BigInt(10_000 - v) * C, { BTC: -1n })) };
    const m = pairMetrics(a, b);
    expect(m.rhoBps).toBe(-10_000n);
    expect(m.flagged).toBe(false); // sync 0
    expect(detect([a, b, { ...a, seat: "c" }]).all).toHaveLength(3);
  });
});
