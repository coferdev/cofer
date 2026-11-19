/**
 * A seat's ledger (spec §4.5): cash, perps (cross-margin), spot. Pure bigint maths, no floats.
 *   prices 1e8 · quantities 1e8 base units · chips 1e6
 * Rounding always goes against the player: credits round down, debits round up, so rounding never creates chips.
 *
 *   Unrealised   U  = q·(M − P̄)
 *   Initial      IM = |q|·P̄/ℓ
 *   Maintenance  MM = |q|·M/(2ℓ)
 *   Spot value   SV = h·M
 *   Equity       E  = C + ΣU + ΣSV (+ options, added by options.ts)
 *   Free margin  F  = E − ΣIM − ΣSV (− options)
 */

export const QTY_SCALE = 10n ** 8n;
export const PX_SCALE = 10n ** 8n;
export const CHIP_SCALE = 10n ** 6n;
/** qty·px is at 1e16; chips are 1e6, so divide by 1e10. */
const NOTIONAL_DIV = (QTY_SCALE * PX_SCALE) / CHIP_SCALE;

export const floorDiv = (a: bigint, b: bigint): bigint => {
  const q = a / b;
  return (a % b !== 0n && (a < 0n) !== (b < 0n)) ? q - 1n : q;
};
export const ceilDiv = (a: bigint, b: bigint): bigint => -floorDiv(-a, b);
const abs = (x: bigint) => (x < 0n ? -x : x);

/** Chips for qty at px, rounded down (a credit) or up (a debit). */
export const notionalDown = (qty: bigint, px: bigint) => floorDiv(abs(qty) * px, NOTIONAL_DIV);
export const notionalUp = (qty: bigint, px: bigint) => ceilDiv(abs(qty) * px, NOTIONAL_DIV);
export const feeOf = (qty: bigint, px: bigint, feeBps: bigint) => ceilDiv(abs(qty) * px * feeBps, NOTIONAL_DIV * 10_000n);

export interface Perp {
  q: bigint; // signed quantity, 1e8
  entry: bigint; // average entry price, 1e8
  lev: bigint; // whole-number leverage chosen at open
}

export interface Seat {
  cash: bigint; // chips, 1e6
  perps: Map<string, Perp>;
  spot: Map<string, bigint>; // holdings, 1e8 (long only)
  eliminatedAt: number | null;
}

export const newSeat = (stack: bigint): Seat => ({ cash: stack, perps: new Map(), spot: new Map(), eliminatedAt: null });

export type Marks = Map<string, bigint>;

const mark = (m: Marks, s: string): bigint => {
  const v = m.get(s);
  if (v === undefined) throw new Error(`no mark for ${s}`);
  return v;
};

/** U = q·(M − P̄), rounded down (a loss rounds to the bigger loss). */
export const unrealised = (p: Perp, m: bigint) => floorDiv(p.q * (m - p.entry), NOTIONAL_DIV);
export const initialMargin = (p: Perp) => ceilDiv(abs(p.q) * p.entry, NOTIONAL_DIV * p.lev);
export const maintenance = (p: Perp, m: bigint) => ceilDiv(abs(p.q) * m, NOTIONAL_DIV * 2n * p.lev);

export function equity(s: Seat, m: Marks, optionValue = 0n): bigint {
  let e = s.cash + optionValue;
  for (const [sym, p] of s.perps) e += unrealised(p, mark(m, sym));
  for (const [sym, h] of s.spot) e += notionalDown(h, mark(m, sym));
  return e;
}

export function freeMargin(s: Seat, m: Marks, optionValue = 0n): bigint {
  let f = equity(s, m, optionValue) - optionValue;
  for (const p of s.perps.values()) f -= initialMargin(p);
  for (const [sym, h] of s.spot) f -= notionalDown(h, mark(m, sym));
  return f;
}

export function totalMaintenance(s: Seat, m: Marks): bigint {
  let t = 0n;
  for (const [sym, p] of s.perps) t += maintenance(p, mark(m, sym));
  return t;
}

/** Gross notional of all positions at the marks (the leverage cap is checked against this). */
export function grossNotional(s: Seat, m: Marks): bigint {
  let g = 0n;
  for (const [sym, p] of s.perps) g += notionalUp(p.q, mark(m, sym));
  for (const [sym, h] of s.spot) g += notionalUp(h, mark(m, sym));
  return g;
}

export type FillResult = { ok: true; fee: bigint; realised: bigint } | { ok: false; reason: "MARGIN" | "CAP" | "ELIMINATED" | "QTY" };

/**
 * A perp fill of signed size dq at price x (spec §4.5): increase, reduce, or reverse (reduce to zero, then open the
 * rest, in that order). A position keeps the leverage it was opened with; `lev` applies to a new or reversed position.
 */
export function fillPerp(s: Seat, sym: string, dq: bigint, x: bigint, lev: bigint, feeBps: bigint, m: Marks, levCap: bigint): FillResult {
  if (s.eliminatedAt !== null) return { ok: false, reason: "ELIMINATED" };
  if (dq === 0n || x <= 0n) return { ok: false, reason: "QTY" };
  const cur = s.perps.get(sym);
  const same = cur && (cur.q > 0n) === (dq > 0n);
  if (!cur || same) return increase(s, sym, dq, x, cur?.lev ?? lev, feeBps, m, levCap);
  // reduce (and maybe reverse)
  const closeQty = abs(dq) > abs(cur.q) ? -cur.q : dq;
  const fee = feeOf(closeQty, x, feeBps);
  const realised = floorDiv(-closeQty * (x - cur.entry), NOTIONAL_DIV); // sgn(q)·|Δq|·(X − P̄), rounded down
  s.cash += realised - fee;
  const left = cur.q + closeQty;
  if (left === 0n) s.perps.delete(sym);
  else s.perps.set(sym, { ...cur, q: left });
  const rest = dq - closeQty;
  if (rest === 0n) return { ok: true, fee, realised };
  const r = increase(s, sym, rest, x, lev, feeBps, m, levCap);
  return r.ok ? { ok: true, fee: fee + r.fee, realised } : { ok: true, fee, realised }; // the close stands; the opening half is refused
}

function increase(s: Seat, sym: string, dq: bigint, x: bigint, lev: bigint, feeBps: bigint, m: Marks, levCap: bigint): FillResult {
  if (lev < 1n || lev > levCap) return { ok: false, reason: "CAP" };
  const fee = feeOf(dq, x, feeBps);
  const need = ceilDiv(abs(dq) * x, NOTIONAL_DIV * lev) + fee;
  if (freeMargin(s, m) < need) return { ok: false, reason: "MARGIN" };
  const withNew = new Map(m).set(sym, x);
  if (grossNotional(s, withNew) + notionalUp(dq, x) > levCap * equity(s, m)) return { ok: false, reason: "CAP" };
  const cur = s.perps.get(sym);
  if (!cur) s.perps.set(sym, { q: dq, entry: x, lev });
  else {
    const a = abs(cur.q);
    const b = abs(dq);
    const num = a * cur.entry + b * x;
    const entry = cur.q > 0n ? ceilDiv(num, a + b) : floorDiv(num, a + b); // a worse average for the player
    s.perps.set(sym, { q: cur.q + dq, entry, lev: cur.lev });
  }
  s.cash -= fee;
  return { ok: true, fee, realised: 0n };
}

/** Spot buy (fully paid, long only): needs cash ≥ cost + fee. */
export function spotBuy(s: Seat, sym: string, qty: bigint, x: bigint, feeBps: bigint): FillResult {
  if (s.eliminatedAt !== null) return { ok: false, reason: "ELIMINATED" };
  if (qty <= 0n || x <= 0n) return { ok: false, reason: "QTY" };
  const cost = notionalUp(qty, x);
  const fee = feeOf(qty, x, feeBps);
  if (s.cash < cost + fee) return { ok: false, reason: "MARGIN" };
  s.cash -= cost + fee;
  s.spot.set(sym, (s.spot.get(sym) ?? 0n) + qty);
  return { ok: true, fee, realised: 0n };
}

/** Spot sell of at most the holding (no spot shorting). */
export function spotSell(s: Seat, sym: string, qty: bigint, x: bigint, feeBps: bigint): FillResult {
  if (s.eliminatedAt !== null) return { ok: false, reason: "ELIMINATED" };
  const h = s.spot.get(sym) ?? 0n;
  if (qty <= 0n || qty > h || x <= 0n) return { ok: false, reason: "QTY" };
  const fee = feeOf(qty, x, feeBps);
  s.cash += notionalDown(qty, x) - fee;
  if (qty === h) s.spot.delete(sym);
  else s.spot.set(sym, h - qty);
  return { ok: true, fee, realised: 0n };
}

/** Elimination check (spec §4.5): E ≤ ΣMM with at least one perp open. */
export const shouldEliminate = (s: Seat, m: Marks, optionValue = 0n) => s.eliminatedAt === null && s.perps.size > 0 && equity(s, m, optionValue) <= totalMaintenance(s, m);

/**
 * Eliminate: every perp closes at the mark (the last valid mark for halted symbols, passed in `m`), spot sells at the
 * mark, E = max(E, 0). Options are sold at bid by the caller before this. No fees on a forced close.
 */
export function eliminate(s: Seat, m: Marks, tsMs: number): bigint {
  const before = equity(s, m);
  for (const [sym, p] of s.perps) s.cash += unrealised(p, mark(m, sym));
  for (const [sym, h] of s.spot) s.cash += notionalDown(h, mark(m, sym));
  s.perps.clear();
  s.spot.clear();
  if (s.cash < 0n) s.cash = 0n;
  s.eliminatedAt = tsMs;
  return before;
}
