/**
 * Options (spec §4.6): European, cash-settled in chips, buy-only. Priced with Black-Scholes (r = 0, no dividend) on
 * the bigint maths in detmath.ts, so the engine, the signers and the public replay get the same chips to the unit.
 *   prices 1e8 · chips 1e6 · vol and time 1e18
 */
import { MARKETS, type Symbol } from "../marks/markets";
import { sessionOnDay } from "../marks/calendar";
import { WAD, lnWad, mulDivDown, mulDivUp, phiWad, sqrtWad } from "./detmath";

export type OptType = "CALL" | "PUT";

/** Contract size in 1e8 base units: BTC 0.01, ETH 0.1, stocks 1 share. */
export const CONTRACT_SIZE: Record<Symbol, bigint> = { BTC: 1_000_000n, ETH: 10_000_000n, NVDA: 100_000_000n, TSLA: 100_000_000n, SPY: 100_000_000n };
/** Strike step at 1e8: BTC 500, ETH 25, NVDA 2.5, TSLA 5, SPY 2. */
export const STRIKE_STEP: Record<Symbol, bigint> = { BTC: 50_000_000_000n, ETH: 2_500_000_000n, NVDA: 250_000_000n, TSLA: 500_000_000n, SPY: 200_000_000n };
export const STRIKES_EACH_SIDE = 5n;
export const SPREAD_BPS = 300n; // 3%
export const ASK_ADD = 10_000n; // 0.01 chip
export const NO_BUY_BEFORE_EXPIRY_MS = 5 * 60_000;
export const SETTLE_WAIT_MS = 300_000;
const YEAR_SEC = 31_536_000n;
const PX_TO_WAD = 10n ** 10n;
const HOUR = 3_600_000;

/** Strikes listed when an expiry is created: round(M/step)·step + k·step, k = −5..+5 (positive strikes only). */
export function listStrikes(sym: Symbol, mark: bigint): bigint[] {
  const step = STRIKE_STEP[sym];
  const base = ((mark + step / 2n) / step) * step;
  const out: bigint[] = [];
  for (let k = -STRIKES_EACH_SIDE; k <= STRIKES_EACH_SIDE; k++) {
    const s = base + k * step;
    if (s > 0n) out.push(s);
  }
  return out;
}

/**
 * The expiries a game lists for a symbol between startMs and endMs (spec §4.6):
 *   crypto: every hour on the hour (4 h ones fall on 00/04/08/12/16/20 UTC, so they are among the hourly ones), and
 *           game end;
 *   stocks: each session close, and game end if it falls inside a session.
 */
export function expiries(sym: Symbol, startMs: number, endMs: number): number[] {
  const out = new Set<number>();
  if (MARKETS[sym].cls === "crypto") {
    for (let t = Math.floor(startMs / HOUR) * HOUR + HOUR; t < endMs; t += HOUR) out.add(t);
  } else {
    for (let d = startMs - 24 * HOUR; d < endMs + 24 * HOUR; d += 24 * HOUR) {
      const s = sessionOnDay(d);
      if (s && s.closeMs > startMs && s.closeMs < endMs) out.add(s.closeMs);
    }
    const s = sessionOnDay(endMs);
    if (!(s && endMs > s.openMs && endMs < s.closeMs)) return [...out].sort((a, b) => a - b);
  }
  out.add(endMs);
  return [...out].sort((a, b) => a - b);
}

/**
 * Black-Scholes model price per 1 unit of the underlying, at 1e8 (rounded down; ask and bid round from here).
 *   T = seconds to expiry / 31,536,000; d1 = [ln(S/K) + σ²T/2]/(σ√T); d2 = d1 − σ√T
 *   Call = S·Φ(d1) − K·Φ(d2);  Put = K·Φ(−d2) − S·Φ(−d1)
 * At or after expiry (T = 0), or with σ = 0, it is the payoff.
 */
export function modelPrice(type: OptType, S: bigint, K: bigint, sigmaWad: bigint, secsToExpiry: bigint): bigint {
  if (S <= 0n || K <= 0n) throw new Error("price must be positive");
  const payoff = type === "CALL" ? (S > K ? S - K : 0n) : K > S ? K - S : 0n;
  if (secsToExpiry <= 0n || sigmaWad <= 0n) return payoff;
  const T = mulDivDown(secsToExpiry, WAD, YEAR_SEC);
  const sWad = S * PX_TO_WAD;
  const kWad = K * PX_TO_WAD;
  const volT = mulDivDown(sigmaWad, sqrtWad(T), WAD);
  if (volT === 0n) return payoff;
  const half = mulDivDown(mulDivDown(sigmaWad, sigmaWad, WAD), T, 2n * WAD);
  const lnSK = lnWad(mulDivDown(sWad, WAD, kWad));
  const d1 = ((lnSK + half) * WAD) / volT;
  const d2 = d1 - volT;
  const v = type === "CALL"
    ? mulDivDown(sWad, phiWad(d1), WAD) - mulDivDown(kWad, phiWad(d2), WAD)
    : mulDivDown(kWad, phiWad(-d2), WAD) - mulDivDown(sWad, phiWad(-d1), WAD);
  const px = v / PX_TO_WAD;
  // never below the payoff a holder could get (rounding near expiry), never negative
  return px < payoff ? payoff : px < 0n ? 0n : px;
}

/** Chips for `contracts` of size `size` at a per-unit price (1e8), rounded down or up. */
const chips = (contracts: bigint, size: bigint, px: bigint, up: boolean) =>
  (up ? mulDivUp : mulDivDown)(contracts * size, px, 10n ** 10n);

/** Ask and bid in chips for `contracts` contracts: ask = model·(1+3%) + 0.01, bid = max(0, model·(1−3%)). */
export function quote(sym: Symbol, type: OptType, S: bigint, K: bigint, sigmaWad: bigint, secsToExpiry: bigint, contracts: bigint) {
  const m = modelPrice(type, S, K, sigmaWad, secsToExpiry);
  const size = CONTRACT_SIZE[sym];
  const ask = mulDivUp(chips(contracts, size, m, true), 10_000n + SPREAD_BPS, 10_000n) + ASK_ADD * contracts;
  const bid = mulDivDown(chips(contracts, size, m, false), 10_000n - SPREAD_BPS, 10_000n);
  return { model: m, ask, bid };
}

export interface OptPos {
  sym: Symbol;
  type: OptType;
  strike: bigint;
  expiry: number; // ms
  contracts: bigint;
  premium: bigint; // chips paid, still outstanding
}

export const seriesId = (sym: Symbol, type: OptType, strike: bigint, expiry: number) => `${sym}:${type}:${strike}:${expiry}`;

export type OptResult = { ok: true; chips: bigint } | { ok: false; reason: "MARKET" | "MARGIN" | "CAP" | "QTY" | "LATE" | "EXPIRED" };

/**
 * Buy at the ask: paid in cash (no margin), refused in the last 5 minutes, and only while total premium outstanding
 * stays within the budget (premiumBudgetBps of the starting stack).
 */
export function buyOption(
  opts: Map<string, OptPos>, cash: bigint, p: Omit<OptPos, "premium">, S: bigint, sigmaWad: bigint, nowMs: number,
  stack: bigint, premiumBudgetBps: bigint, listed: Set<string>,
): OptResult & { cashAfter?: bigint } {
  const id = seriesId(p.sym, p.type, p.strike, p.expiry);
  if (!listed.has(id)) return { ok: false, reason: "MARKET" };
  if (p.contracts <= 0n) return { ok: false, reason: "QTY" };
  if (nowMs >= p.expiry) return { ok: false, reason: "EXPIRED" };
  if (nowMs > p.expiry - NO_BUY_BEFORE_EXPIRY_MS) return { ok: false, reason: "LATE" };
  const secs = BigInt(Math.floor((p.expiry - nowMs) / 1000));
  const { ask } = quote(p.sym, p.type, S, p.strike, sigmaWad, secs, p.contracts);
  let outstanding = 0n;
  for (const o of opts.values()) outstanding += o.premium;
  if ((outstanding + ask) * 10_000n > stack * premiumBudgetBps) return { ok: false, reason: "CAP" };
  if (cash < ask) return { ok: false, reason: "MARGIN" };
  const cur = opts.get(id);
  opts.set(id, cur ? { ...cur, contracts: cur.contracts + p.contracts, premium: cur.premium + ask } : { ...p, premium: ask });
  return { ok: true, chips: ask, cashAfter: cash - ask };
}

/** Sell an open long option at the bid, before expiry (the caller checks the 60 s hold). Premium is released pro rata. */
export function sellOption(opts: Map<string, OptPos>, id: string, contracts: bigint, S: bigint, sigmaWad: bigint, nowMs: number): OptResult {
  const o = opts.get(id);
  if (!o || contracts <= 0n || contracts > o.contracts) return { ok: false, reason: "QTY" };
  if (nowMs >= o.expiry) return { ok: false, reason: "EXPIRED" };
  const secs = BigInt(Math.floor((o.expiry - nowMs) / 1000));
  const { bid } = quote(o.sym, o.type, S, o.strike, sigmaWad, secs, contracts);
  if (contracts === o.contracts) opts.delete(id);
  else {
    const left = o.contracts - contracts;
    opts.set(id, { ...o, contracts: left, premium: mulDivUp(o.premium, left, o.contracts) });
  }
  return { ok: true, chips: bid };
}

/** Option value for equity (OV = Σ contracts·size·bid), with a mark per symbol at nowMs. */
export function optionValue(opts: Map<string, OptPos>, marks: Map<string, bigint>, sigma: Map<string, bigint>, nowMs: number): bigint {
  let v = 0n;
  for (const o of opts.values()) {
    const S = marks.get(o.sym);
    if (S === undefined) continue; // no mark yet: valued at 0, the side against the player
    const secs = BigInt(Math.max(0, Math.floor((o.expiry - nowMs) / 1000)));
    v += quote(o.sym, o.type, S, o.strike, sigma.get(o.sym) ?? 0n, secs, o.contracts).bid;
  }
  return v;
}

/** Settle every option of `sym` expiring at `expiry` at settlement price S: payoff × size, rounded down, to cash. */
export function settle(opts: Map<string, OptPos>, sym: Symbol, expiry: number, S: bigint): bigint {
  let paid = 0n;
  for (const [id, o] of [...opts].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (o.sym !== sym || o.expiry !== expiry) continue;
    const payoff = o.type === "CALL" ? (S > o.strike ? S - o.strike : 0n) : o.strike > S ? o.strike - S : 0n;
    paid += chips(o.contracts, CONTRACT_SIZE[sym], payoff, false);
    opts.delete(id);
  }
  return paid;
}

/**
 * The settlement price for an expiry (spec §4.6): the mark of the first valid tick at or after τ within 300 s,
 * otherwise the last valid mark at or before τ. `ticks` are (ts, mark or null when not valid) in time order.
 */
export function settlementPrice(ticks: { ts: number; mark: bigint | null }[], expiry: number): bigint | null {
  const after = ticks.find((t) => t.ts >= expiry && t.ts <= expiry + SETTLE_WAIT_MS && t.mark !== null);
  if (after) return after.mark;
  let last: bigint | null = null;
  for (const t of ticks) if (t.ts <= expiry && t.mark !== null) last = t.mark;
  return last;
}
