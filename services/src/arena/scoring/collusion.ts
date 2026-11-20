/**
 * Collusion detection (spec §4.10), on one-minute samples, for every pair of seats (eliminated seats up to their
 * eliminatedAt), integers only:
 *   O   = Σ_t Σ_s min(|x_i|, |x_j|)·[opposite signs] / Σ_t min(G_i, G_j)      (samples where both have exposure)
 *   ρ   = corr(ΔE_i, ΔE_j) over shared minute samples (needs ≥ 5; with fewer it counts as met)
 *   sync = times i and j opened opposite positions in the same symbol within 120 s
 *   flag ⇔ O ≥ 0.6 ∧ ρ ≤ −0.8 ∧ (sync ≥ 2 ∨ (sync ≥ 1 ∧ one was eliminated holding that opposite position))
 * ρ is compared without a square root: ρ ≤ −0.8 ⇔ cov < 0 ∧ cov² ≥ 0.64·var_i·var_j.
 */
import { isqrt } from "../engine/detmath";

export interface MinuteSample {
  ts: number;
  equity: bigint;
  /** Signed notional per symbol, chips. */
  x: Map<string, bigint>;
}

export interface OpenEvent {
  ts: number;
  symbol: string;
  sign: 1 | -1;
}

export interface SeatTrace {
  seat: string;
  samples: MinuteSample[]; // in time order, one per minute
  opens: OpenEvent[];
  eliminatedAt: number | null;
  /** Signed notional per symbol held at elimination. */
  heldAtElimination?: Map<string, bigint>;
}

export interface CollusionParams {
  oBps: bigint; // 6,000
  rhoBps: bigint; // −8,000
  sync: number; // 2
  windowMs: number; // 120,000
  minRhoSamples: number; // 5
}

export const DEFAULT_COLLUSION: CollusionParams = { oBps: 6_000n, rhoBps: -8_000n, sync: 2, windowMs: 120_000, minRhoSamples: 5 };

const abs = (v: bigint) => (v < 0n ? -v : v);
const gross = (x: Map<string, bigint>) => [...x.values()].reduce((a, v) => a + abs(v), 0n);

export interface PairMetrics {
  a: string;
  b: string;
  oBps: bigint;
  rhoBps: bigint | null; // null: fewer than minRhoSamples shared samples
  sync: number;
  eliminatedHolding: boolean;
  flagged: boolean;
}

export function pairMetrics(i: SeatTrace, j: SeatTrace, p: CollusionParams = DEFAULT_COLLUSION): PairMetrics {
  const until = (t: SeatTrace) => t.eliminatedAt ?? Number.MAX_SAFE_INTEGER;
  const end = Math.min(until(i), until(j));
  const bj = new Map(j.samples.map((s) => [s.ts, s]));
  let opp = 0n;
  let both = 0n;
  const dI: bigint[] = [];
  const dJ: bigint[] = [];
  let prev: [MinuteSample, MinuteSample] | null = null;
  for (const si of i.samples) {
    if (si.ts > end) break;
    const sj = bj.get(si.ts);
    if (!sj) continue;
    const gi = gross(si.x);
    const gj = gross(sj.x);
    if (gi > 0n && gj > 0n) {
      both += gi < gj ? gi : gj;
      for (const [sym, xi] of si.x) {
        const xj = sj.x.get(sym) ?? 0n;
        if (xi !== 0n && xj !== 0n && (xi > 0n) !== (xj > 0n)) opp += abs(xi) < abs(xj) ? abs(xi) : abs(xj);
      }
    }
    if (prev) {
      dI.push(si.equity - prev[0].equity);
      dJ.push(sj.equity - prev[1].equity);
    }
    prev = [si, sj];
  }
  const oBps = both === 0n ? 0n : (opp * 10_000n) / both;

  let rhoBps: bigint | null = null;
  let rhoMet = true;
  if (dI.length >= p.minRhoSamples) {
    const n = BigInt(dI.length);
    const sI = dI.reduce((a, v) => a + v, 0n);
    const sJ = dJ.reduce((a, v) => a + v, 0n);
    let cov = 0n;
    let vI = 0n;
    let vJ = 0n;
    for (let k = 0; k < dI.length; k++) {
      const a = dI[k]! * n - sI;
      const b = dJ[k]! * n - sJ;
      cov += a * b;
      vI += a * a;
      vJ += b * b;
    }
    if (vI === 0n || vJ === 0n) {
      rhoBps = 0n;
      rhoMet = false;
    } else {
      // ρ ≤ r (r < 0) ⇔ cov < 0 ∧ cov²·1e8 ≥ r²·vI·vJ
      rhoMet = cov < 0n && cov * cov * 100_000_000n >= p.rhoBps * p.rhoBps * vI * vJ;
      const mag = isqrt((cov * cov * 100_000_000n) / (vI * vJ));
      rhoBps = cov < 0n ? -mag : mag;
    }
  }

  let sync = 0;
  const used = new Set<number>();
  for (const a of i.opens) {
    if (a.ts > end) continue;
    const k = j.opens.findIndex((b, idx) => !used.has(idx) && b.ts <= end && b.symbol === a.symbol && b.sign !== a.sign && Math.abs(b.ts - a.ts) <= p.windowMs);
    if (k >= 0) {
      used.add(k);
      sync++;
    }
  }

  const heldOpp = (dead: SeatTrace, alive: SeatTrace) => {
    if (dead.eliminatedAt === null || !dead.heldAtElimination) return false;
    const last = [...alive.samples].reverse().find((s) => s.ts <= dead.eliminatedAt!);
    if (!last) return false;
    for (const [sym, x] of dead.heldAtElimination) {
      const y = last.x.get(sym) ?? 0n;
      if (x !== 0n && y !== 0n && (x > 0n) !== (y > 0n)) return true;
    }
    return false;
  };
  const eliminatedHolding = heldOpp(i, j) || heldOpp(j, i);
  const flagged = oBps >= p.oBps && rhoMet && (sync >= p.sync || (sync >= 1 && eliminatedHolding));
  return { a: i.seat, b: j.seat, oBps, rhoBps, sync, eliminatedHolding, flagged };
}

/**
 * Every pair that can be flagged, in seat order. A flag needs sync ≥ 1, so only pairs with at least one pair of
 * opposite opens in the same symbol within the window are measured (the same flags as measuring all pairs, and a
 * 4,096-seat Freeroll stays cheap). Returns the flagged pairs and the measured metrics (for the Flag events).
 */
export function detect(traces: SeatTrace[], p: CollusionParams = DEFAULT_COLLUSION) {
  const bySym = new Map<string, { ts: number; sign: 1 | -1; i: number }[]>();
  traces.forEach((t, i) => {
    for (const o of t.opens) {
      if (t.eliminatedAt !== null && o.ts > t.eliminatedAt) continue;
      const l = bySym.get(o.symbol) ?? [];
      l.push({ ts: o.ts, sign: o.sign, i });
      bySym.set(o.symbol, l);
    }
  });
  const cand = new Set<number>();
  const n = traces.length;
  for (const l of bySym.values()) {
    l.sort((a, b) => a.ts - b.ts || a.i - b.i);
    for (let a = 0; a < l.length; a++)
      for (let b = a + 1; b < l.length && l[b]!.ts - l[a]!.ts <= p.windowMs; b++) {
        if (l[a]!.sign === l[b]!.sign || l[a]!.i === l[b]!.i) continue;
        const [x, y] = l[a]!.i < l[b]!.i ? [l[a]!.i, l[b]!.i] : [l[b]!.i, l[a]!.i];
        cand.add(x * n + y);
      }
  }
  const all = [...cand].sort((a, b) => a - b).map((k) => pairMetrics(traces[Math.floor(k / n)]!, traces[k % n]!, p));
  return { flagged: all.filter((m) => m.flagged).map((m) => [m.a, m.b] as [string, string]), all };
}
