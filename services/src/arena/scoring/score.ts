/**
 * Scoring and ranking (spec §4.9). All bigint, at 1e6:
 *   R = E(end)/E₀ − 1 (rounded down)      D = max drawdown (rounded up)      S = R − λ·D
 *   Active = fills ≥ N_min ∧ time with exposure ≥ ρ · duration
 * Tiers: active survivors by S, then inactive survivors by S, then eliminated seats by eliminatedAt (later is higher).
 * Ties: lower D first, then the earlier seat index. A collusion flag (collusion.ts) sets both seats' S to the lower
 * one before ranking (an eliminated counterpart counts as −1).
 */
export const SCORE_SCALE = 1_000_000n;

export interface ScoreInput {
  seat: string;
  index: number;
  finalEquity: bigint; // chips 1e6
  maxDdBps: bigint;
  fills: number;
  exposedMs: number;
  eliminatedAt: number | null;
}

export interface ScoreRules {
  stack: bigint; // E₀
  lambdaBps: bigint; // 5,000 = 0.5
  minFills: number;
  minExposureBps: bigint; // 2,000 = 20%
  durationMs: number;
}

export interface Standing {
  rank: number; // 1 = first
  seat: string;
  finalEquity: bigint;
  maxDrawdownBps: bigint;
  score1e6: bigint;
  activityOk: boolean;
  eliminatedAt: number | null;
  flags: number; // bit 1 = COLLUSION
}

export const FLAG_COLLUSION = 1;

const floorDiv = (a: bigint, b: bigint) => {
  const q = a / b;
  return a % b !== 0n && (a < 0n) !== (b < 0n) ? q - 1n : q;
};

export function scoreOf(x: ScoreInput, r: ScoreRules): bigint {
  const R = floorDiv((x.finalEquity - r.stack) * SCORE_SCALE, r.stack);
  const D = (x.maxDdBps * SCORE_SCALE + 9_999n) / 10_000n;
  return R - (r.lambdaBps * D + 9_999n) / 10_000n;
}

export const isActive = (x: ScoreInput, r: ScoreRules) =>
  x.fills >= r.minFills && BigInt(x.exposedMs) * 10_000n >= r.minExposureBps * BigInt(r.durationMs);

/** Rank the seats. `pairs` are flagged pairs from collusion detection. */
export function rank(xs: ScoreInput[], r: ScoreRules, pairs: [string, string][] = []): Standing[] {
  const S = new Map<string, bigint>();
  for (const x of xs) S.set(x.seat, x.eliminatedAt !== null ? -SCORE_SCALE : scoreOf(x, r));
  const flagged = new Set<string>();
  // apply the min over each flagged pair until nothing changes (a chain of pairs ends at its lowest score)
  for (let changed = pairs.length > 0; changed;) {
    changed = false;
    for (const [a, b] of pairs) {
      const m = S.get(a)! < S.get(b)! ? S.get(a)! : S.get(b)!;
      for (const k of [a, b]) {
        flagged.add(k);
        if (S.get(k)! !== m) (S.set(k, m), (changed = true));
      }
    }
  }
  const tier = (x: ScoreInput) => (x.eliminatedAt !== null ? 2 : isActive(x, r) ? 0 : 1);
  const sorted = [...xs].sort((a, b) => {
    const ta = tier(a);
    const tb = tier(b);
    if (ta !== tb) return ta - tb;
    if (ta === 2 && a.eliminatedAt !== b.eliminatedAt) return b.eliminatedAt! - a.eliminatedAt!;
    if (ta !== 2) {
      const sa = S.get(a.seat)!;
      const sb = S.get(b.seat)!;
      if (sa !== sb) return sa > sb ? -1 : 1;
    }
    if (a.maxDdBps !== b.maxDdBps) return a.maxDdBps < b.maxDdBps ? -1 : 1;
    return a.index - b.index;
  });
  return sorted.map((x, i) => ({
    rank: i + 1,
    seat: x.seat,
    finalEquity: x.finalEquity,
    maxDrawdownBps: x.maxDdBps,
    score1e6: x.eliminatedAt !== null ? -SCORE_SCALE : S.get(x.seat)!,
    activityOk: isActive(x, r),
    eliminatedAt: x.eliminatedAt,
    flags: flagged.has(x.seat) ? FLAG_COLLUSION : 0,
  }));
}

/** Season points (spec §4.9): round(100·(n − rank)/(n − 1)) + {25, 15, 10} for the podium; heads-up 60 / 20. */
export function seasonPoints(rankPos: number, n: number): number {
  if (n === 2) return rankPos === 1 ? 60 : 20;
  if (n < 3) return 0;
  const base = Math.floor((200 * (n - rankPos) + (n - 1)) / (2 * (n - 1))); // round half up, integers only
  return base + (rankPos === 1 ? 25 : rankPos === 2 ? 15 : rankPos === 3 ? 10 : 0);
}
