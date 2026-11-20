import { describe, expect, test } from "bun:test";
import { BAND, TIER_STEP, lbKey, lbScore, lbZadd } from "../src/arena/scoring/leaderboard";
import { type ScoreInput, rank } from "../src/arena/scoring/score";

const START = 1_800_000_000_000;
const R = { stack: 10_000_000_000n, lambdaBps: 5000n, minFills: 1, minExposureBps: 2000n, durationMs: 3_600_000 };
const seat = (i: number) => `0x${i.toString(16).padStart(40, "0")}`;
const inp = (i: number, eq: bigint, fills: number, exposedMs: number, elim: number | null = null, dd = 100n): ScoreInput =>
  ({ seat: seat(i), index: i, finalEquity: eq, maxDdBps: dd, fills, exposedMs, eliminatedAt: elim });

describe("leaderboard key", () => {
  test("reading highest first gives the final standings' order across all three tiers", () => {
    const xs = [
      inp(1, 12_000_000_000n, 3, 3_000_000),
      inp(2, 9_000_000_000n, 3, 3_000_000),
      inp(3, 30_000_000_000n, 0, 0), // inactive, however rich
      inp(4, 0n, 2, 1_000_000, START + 600_000),
      inp(5, 0n, 2, 1_000_000, START + 1_200_000),
      inp(6, 10_500_000_000n, 5, 3_500_000, null, 900n),
    ];
    const st = rank(xs, R);
    const z = lbZadd(st, START);
    const pairs: [number, string][] = [];
    for (let i = 0; i < z.length; i += 2) pairs.push([z[i] as number, z[i + 1] as string]);
    const byKey = [...pairs].sort((a, b) => b[0] - a[0]).map((p) => p[1]);
    expect(byKey).toEqual(st.map((s) => s.seat));
    expect(new Set(pairs.map((p) => p[0])).size).toBe(pairs.length);
  });

  test("bands: S is clamped, tiers never overlap, eliminated stays in tier 0", () => {
    expect(lbScore({ score1e6: 10n ** 12n, activityOk: true, eliminatedAt: null }, START)).toBe(2 * TIER_STEP + BAND);
    expect(lbScore({ score1e6: -(10n ** 12n), activityOk: true, eliminatedAt: null }, START)).toBe(2 * TIER_STEP - BAND);
    expect(lbScore({ score1e6: 10n ** 12n, activityOk: false, eliminatedAt: null }, START)).toBe(TIER_STEP + BAND);
    expect(lbScore({ score1e6: 0n, activityOk: true, eliminatedAt: START }, START)).toBe(-BAND);
    expect(lbScore({ score1e6: 0n, activityOk: true, eliminatedAt: START + 10 ** 10 }, START)).toBe(BAND);
    expect(BAND < TIER_STEP - BAND).toBe(true);
    expect(lbKey("0xABc")).toBe("lb:0xabc");
  });
});
