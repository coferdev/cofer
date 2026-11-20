/**
 * Orders, fills and the minimum hold (spec §4.4). Pure: time enters only as the logged `recvTs` of an order and the
 * `ts` of a tick, and every decision is a function of the log. Option orders (OPT_BUY / OPT_SELL) price through options.ts.
 *
 *   - Next tick, never the screen price: an order can fill only at a tick with ts > recvTs + Δ.
 *   - Fresh after the order: that tick's mark must be built only from venue quotes received after recvTs + Δ.
 *   - Minimum hold H: reducing, closing or reversing a symbol before lastIncrease + H is refused (HOLD); a resting
 *     LIMIT or an armed STOP / TAKE_PROFIT that crosses early stays where it is and runs at the first tick after the hold.
 */
import { MARKETS, type MarketClass, type Symbol, isSymbol } from "../marks/markets";
import type { Mark } from "../marks/median";
import { type Marks, type Seat, fillPerp, freeMargin, newSeat, spotBuy, spotSell } from "./ledger";
import type { CollusionParams } from "../scoring/collusion";
import { type OptPos, type OptType, buyOption, listStrikes, sellOption, seriesId } from "./options";

export type OrderKind = "MARKET" | "LIMIT" | "STOP" | "TAKE_PROFIT" | "CLOSE" | "CANCEL" | "OPT_BUY" | "OPT_SELL";
export type Product = "SPOT" | "PERP" | "OPTION";
export type Side = "BUY" | "SELL";

/** An order as the engine logs it, after the signature and the session key were checked at ingress. */
export interface Order {
  seat: string;
  nonce: bigint;
  kind: OrderKind;
  symbol: string; // a Symbol, or "*" for CLOSE all
  product: Product;
  side?: Side;
  qty?: bigint; // 1e8
  notional?: bigint; // chips 1e6
  pctFreeBps?: bigint; // 1..10,000 of free margin
  leverage?: bigint;
  limitPx?: bigint;
  triggerPx?: bigint;
  reduceOnly?: boolean;
  option?: { type: OptType; strike: bigint; expiry: number; contracts: bigint };
  cancelRef?: string;
  clientId: string;
  validUntil?: number; // ms
}

export type Reason =
  | "NO_MARK" | "HOLD" | "MARGIN" | "CLOSED_MARKET" | "RATE" | "NONCE" | "CAP" | "ELIMINATED"
  | "QTY" | "MARKET" | "EXPIRED" | "NOT_FOUND" | "LATE";

export interface Rules {
  markets: Symbol[];
  products: Product[];
  leverageCap: Partial<Record<MarketClass, bigint>>;
  stack: bigint;
  fillDelayMs: number; // Δ
  minHoldMs: number; // H
  feeBps: bigint;
  noMarkMs: number; // a MARKET with no fresh valid mark this long after Δ is cancelled
  ordersPerSec: number;
  maxResting: number;
  /** Option underlyings, σ per symbol (WAD, fixed for the game, in the rules JSON) and the premium budget. */
  optionMarkets: Symbol[];
  sigma: Partial<Record<Symbol, bigint>>;
  premiumBudgetBps: bigint;
  /** Collusion thresholds (spec §4.10); the defaults when absent. */
  collusion?: CollusionParams;
}

export const PRACTICE_RULES: Rules = {
  markets: ["BTC", "ETH", "NVDA", "TSLA", "SPY"],
  products: ["SPOT", "PERP", "OPTION"],
  leverageCap: { crypto: 20n, stock: 10n },
  stack: 10_000_000_000n,
  fillDelayMs: 1_000,
  minHoldMs: 60_000,
  feeBps: 5n,
  noMarkMs: 30_000,
  ordersPerSec: 2,
  maxResting: 100,
  optionMarkets: ["BTC", "ETH", "NVDA", "TSLA", "SPY"],
  sigma: { BTC: 520_000_000_000_000_000n, ETH: 680_000_000_000_000_000n, NVDA: 450_000_000_000_000_000n, TSLA: 600_000_000_000_000_000n, SPY: 200_000_000_000_000_000n },
  premiumBudgetBps: 5_000n,
};

interface Live {
  o: Order;
  recvTs: number;
  seq: number;
  /** STOP / TAKE_PROFIT that crossed: it now runs as a MARKET from this tick on. */
  firedAt?: number;
}

export interface SeatState {
  ledger: Seat;
  lastNonce: bigint;
  recent: number[]; // recvTs of orders in the last second (the rate limit)
  lastIncrease: Map<string, number>; // by symbol, or by option series id
  options: Map<string, OptPos>;
}

export interface Book {
  rules: Rules;
  seats: Map<string, SeatState>;
  live: Live[]; // every order waiting for a tick, in seq order
  lastValid: Marks; // last OK mark per symbol (valuation, and halted symbols)
  listed: Set<string>; // option series open for buying
}

export type Emitted =
  | { t: "Accepted"; seat: string; clientId: string; seq: number }
  | { t: "Reject"; seat: string; clientId: string; reason: Reason; ts: number }
  | { t: "Fill"; seat: string; clientId: string; symbol: Symbol; product: Product; dq: bigint; px: bigint; fee: bigint; realised: bigint; ts: number }
  | { t: "OptFill"; seat: string; clientId: string; series: string; contracts: bigint; chips: bigint; ts: number }
  | { t: "Fired"; seat: string; clientId: string; ts: number }
  | { t: "Cancelled"; seat: string; clientId: string; ref: string; ts: number };

export const newBook = (rules: Rules): Book => ({ rules, seats: new Map(), live: [], lastValid: new Map(), listed: new Set() });

/** List an expiry for a symbol at the mark at its creation (spec §4.1 step 2; game.ts decides when). */
export function listExpiry(b: Book, sym: Symbol, expiry: number, mark: bigint): string[] {
  const ids: string[] = [];
  for (const k of listStrikes(sym, mark)) for (const t of ["CALL", "PUT"] as const) ids.push(seriesId(sym, t, k, expiry));
  for (const id of ids) b.listed.add(id);
  return ids;
}

/** An expiry passed: its series can no longer be bought. */
export function delistExpiry(b: Book, sym: Symbol, expiry: number): void {
  for (const id of [...b.listed]) if (id.startsWith(`${sym}:`) && id.endsWith(`:${expiry}`)) b.listed.delete(id);
}

export function addSeat(b: Book, seat: string): SeatState {
  const s: SeatState = { ledger: newSeat(b.rules.stack), lastNonce: -1n, recent: [], lastIncrease: new Map(), options: new Map() };
  b.seats.set(seat, s);
  return s;
}

const abs = (x: bigint) => (x < 0n ? -x : x);
/** Orders that run at the next fresh tick (not resting until a price): they time out with NO_MARK. */
const now_ = (o: Order, l: Live) => o.kind === "MARKET" || o.kind === "OPT_BUY" || o.kind === "OPT_SELL" || l.firedAt !== undefined;
const resting = (k: OrderKind) => k === "LIMIT" || k === "STOP" || k === "TAKE_PROFIT";

/** An order arrives (OrderIn, logged with its engine receive time and seq). */
export function ingest(b: Book, o: Order, recvTs: number, seq: number): Emitted[] {
  const s = b.seats.get(o.seat);
  const rej = (reason: Reason): Emitted[] => [{ t: "Reject", seat: o.seat, clientId: o.clientId, reason, ts: recvTs }];
  if (!s) return rej("NOT_FOUND");
  if (s.ledger.eliminatedAt !== null) return rej("ELIMINATED");
  if (o.nonce <= s.lastNonce) return rej("NONCE");
  s.lastNonce = o.nonce; // a used nonce stays used even if the order is refused below
  s.recent = s.recent.filter((t) => t > recvTs - 1_000);
  if (s.recent.length >= b.rules.ordersPerSec) return rej("RATE");
  s.recent.push(recvTs);

  if (o.kind === "CANCEL") {
    const i = b.live.findIndex((l) => l.o.seat === o.seat && l.o.clientId === o.cancelRef);
    if (i < 0) return rej("NOT_FOUND");
    b.live.splice(i, 1);
    return [{ t: "Cancelled", seat: o.seat, clientId: o.clientId, ref: o.cancelRef!, ts: recvTs }];
  }
  const bad = shape(b.rules, o);
  if (bad) return rej(bad);
  if (resting(o.kind) && b.live.filter((l) => l.o.seat === o.seat && resting(l.o.kind)).length >= b.rules.maxResting) return rej("CAP");
  b.live.push({ o, recvTs, seq });
  return [{ t: "Accepted", seat: o.seat, clientId: o.clientId, seq }];
}

/** Checks that need nothing but the order and the rules. */
function shape(r: Rules, o: Order): Reason | null {
  if (o.kind === "CLOSE" && o.symbol === "*") return null;
  if (!isSymbol(o.symbol) || !r.markets.includes(o.symbol)) return "MARKET";
  if (!r.products.includes(o.product)) return "MARKET";
  if (o.kind === "CLOSE") return null;
  if (o.kind === "OPT_BUY" || o.kind === "OPT_SELL") {
    if (o.product !== "OPTION" || !r.optionMarkets.includes(o.symbol) || r.sigma[o.symbol] === undefined) return "MARKET";
    const x = o.option;
    return x && (x.type === "CALL" || x.type === "PUT") && x.strike > 0n && x.contracts > 0n ? null : "QTY";
  }
  if (o.product === "OPTION") return "MARKET";
  if (o.side !== "BUY" && o.side !== "SELL") return "QTY";
  const sizes = [o.qty, o.notional, o.pctFreeBps].filter((v) => v !== undefined).length;
  const triggerKind = o.kind === "STOP" || o.kind === "TAKE_PROFIT";
  if (triggerKind ? sizes > 1 : sizes !== 1) return "QTY"; // a trigger without a size closes the whole position
  if ((o.qty ?? 1n) <= 0n || (o.notional ?? 1n) <= 0n) return "QTY";
  if (o.pctFreeBps !== undefined && (o.pctFreeBps <= 0n || o.pctFreeBps > 10_000n)) return "QTY";
  if (o.kind === "LIMIT" && !(o.limitPx && o.limitPx > 0n)) return "QTY";
  if (triggerKind && !(o.triggerPx && o.triggerPx > 0n)) return "QTY";
  if (o.product === "PERP") {
    const cap = r.leverageCap[MARKETS[o.symbol].cls];
    const lev = o.leverage ?? 1n;
    if (cap === undefined || lev < 1n || lev > cap) return "CAP";
  }
  return null;
}

const posOf = (s: SeatState, o: Order, sym: Symbol): bigint =>
  o.product === "PERP" ? (s.ledger.perps.get(sym)?.q ?? 0n) : (s.ledger.spot.get(sym) ?? 0n);

const inHold = (b: Book, s: SeatState, sym: string, ts: number) => {
  const t = s.lastIncrease.get(sym);
  return t !== undefined && ts < t + b.rules.minHoldMs;
};

/** Signed size for an opening order at price px (rounded down: never more than asked or affordable). */
function sizeOf(b: Book, s: SeatState, o: Order, px: bigint): bigint {
  const sign = o.side === "BUY" ? 1n : -1n;
  if (o.qty !== undefined) return sign * o.qty;
  let chips: bigint;
  if (o.notional !== undefined) chips = o.notional;
  else {
    const free = freeMargin(s.ledger, b.lastValid);
    const base = o.product === "SPOT" ? (free < s.ledger.cash ? free : s.ledger.cash) : free;
    chips = base <= 0n ? 0n : (base * o.pctFreeBps!) / 10_000n;
    if (o.product === "PERP") chips *= o.leverage ?? 1n;
    // leave room for the fee, so 100% of free margin is a valid order
    chips = (chips * 10_000n) / (10_000n + b.rules.feeBps * (o.product === "PERP" ? (o.leverage ?? 1n) : 1n));
  }
  return (sign * chips * 10n ** 10n) / px;
}

/** One tick (spec §4.1 step 1: due fills, in log seq order). `marks` is this tick's mark per symbol. */
export function onTick(b: Book, ts: number, marks: Map<string, Mark>): Emitted[] {
  for (const [sym, m] of marks) if (m.status === "OK" && m.mark !== null) b.lastValid.set(sym, m.mark);
  const out: Emitted[] = [];
  const keep: Live[] = [];
  const queue = [...b.live].sort((x, y) => x.seq - y.seq);
  b.live = [];
  for (const l of queue) {
    const s = b.seats.get(l.o.seat)!;
    const r = step(b, s, l, ts, marks, out);
    if (r === "keep") keep.push(l);
  }
  // orders that arrived during this tick's processing do not exist: ingest and onTick never interleave
  b.live = keep.concat(b.live).sort((x, y) => x.seq - y.seq);
  return out;
}

function step(b: Book, s: SeatState, l: Live, ts: number, marks: Map<string, Mark>, out: Emitted[]): "keep" | "done" {
  const o = l.o;
  const rej = (reason: Reason): "done" => (out.push({ t: "Reject", seat: o.seat, clientId: o.clientId, reason, ts }), "done");
  if (s.ledger.eliminatedAt !== null) return rej("ELIMINATED");
  if (o.validUntil !== undefined && ts > o.validUntil) return rej("EXPIRED");
  const from = (l.firedAt ?? l.recvTs) + b.rules.fillDelayMs;
  if (ts <= from) return "keep";

  if (o.kind === "CLOSE") return close(b, s, l, ts, marks, from, out);

  const sym = o.symbol as Symbol;
  const m = marks.get(sym);
  if (m?.status === "CLOSED") {
    if (now_(o, l)) return rej("CLOSED_MARKET");
    return "keep";
  }
  const fresh = m && m.status === "OK" && m.mark !== null && m.venueFreshFromMs !== null && m.venueFreshFromMs > from;
  if (!fresh) {
    if (now_(o, l) && ts > from + b.rules.noMarkMs) return rej("NO_MARK");
    return "keep";
  }
  const px = m!.mark!;
  if (o.kind === "OPT_BUY" || o.kind === "OPT_SELL") return option(b, s, l, ts, px, out);
  const pos = posOf(s, o, sym);

  if ((o.kind === "STOP" || o.kind === "TAKE_PROFIT") && l.firedAt === undefined) {
    if (pos === 0n) return rej("QTY"); // reduce-only with nothing to reduce
    const long = pos > 0n;
    const t = o.triggerPx!;
    const crossed = o.kind === "STOP" ? (long ? px <= t : px >= t) : long ? px >= t : px <= t;
    if (!crossed || inHold(b, s, sym, ts)) return "keep";
    l.firedAt = ts;
    out.push({ t: "Fired", seat: o.seat, clientId: o.clientId, ts });
    return "keep"; // runs as a MARKET from the next tick whose mark is fresh after it
  }

  if (o.kind === "LIMIT") {
    const through = o.side === "BUY" ? px <= o.limitPx! : px >= o.limitPx!;
    if (!through) return "keep";
  }

  // the size, and whether this fill reduces
  let dq: bigint;
  if (l.firedAt !== undefined) {
    if (pos === 0n) return rej("QTY");
    const want = o.qty ?? abs(pos);
    dq = (pos > 0n ? -1n : 1n) * (want < abs(pos) ? want : abs(pos));
  } else {
    dq = sizeOf(b, s, o, px);
    if (o.reduceOnly) {
      if (pos === 0n || (pos > 0n) === (dq > 0n)) return rej("QTY");
      if (abs(dq) > abs(pos)) dq = -pos;
    }
  }
  if (dq === 0n) return rej("QTY");
  const reduces = pos !== 0n && (pos > 0n) !== (dq > 0n);
  if (reduces && inHold(b, s, sym, ts)) return o.kind === "MARKET" && l.firedAt === undefined ? rej("HOLD") : "keep";

  const r = o.product === "PERP"
    ? fillPerp(s.ledger, sym, dq, px, o.leverage ?? 1n, b.rules.feeBps, b.lastValid, b.rules.leverageCap[MARKETS[sym].cls] ?? 1n)
    : dq > 0n ? spotBuy(s.ledger, sym, dq, px, b.rules.feeBps) : spotSell(s.ledger, sym, -dq, px, b.rules.feeBps);
  if (!r.ok) return rej(r.reason);
  const opened = !reduces || abs(dq) > abs(pos);
  if (opened) s.lastIncrease.set(sym, ts);
  out.push({ t: "Fill", seat: o.seat, clientId: o.clientId, symbol: sym, product: o.product, dq, px, fee: r.fee, realised: r.realised, ts });
  return "done";
}

/** CLOSE one symbol or all ("*"): every position that is out of its hold and has a fresh mark closes at this tick. */
function close(b: Book, s: SeatState, l: Live, ts: number, marks: Map<string, Mark>, from: number, out: Emitted[]): "keep" | "done" {
  const o = l.o;
  const syms = o.symbol === "*" ? [...new Set([...s.ledger.perps.keys(), ...s.ledger.spot.keys()])].sort() : [o.symbol];
  if (syms.length === 0) return (out.push({ t: "Reject", seat: o.seat, clientId: o.clientId, reason: "QTY", ts }), "done");
  const held = syms.filter((x) => inHold(b, s, x, ts));
  if (held.length) return (out.push({ t: "Reject", seat: o.seat, clientId: o.clientId, reason: "HOLD", ts }), "done");
  const notFresh = syms.filter((x) => {
    const m = marks.get(x);
    return !(m && m.status === "OK" && m.mark !== null && m.venueFreshFromMs !== null && m.venueFreshFromMs > from);
  });
  if (notFresh.length) {
    if (syms.some((x) => marks.get(x)?.status === "CLOSED")) return (out.push({ t: "Reject", seat: o.seat, clientId: o.clientId, reason: "CLOSED_MARKET", ts }), "done");
    if (ts > from + b.rules.noMarkMs) return (out.push({ t: "Reject", seat: o.seat, clientId: o.clientId, reason: "NO_MARK", ts }), "done");
    return "keep"; // all of them close together, at one tick
  }
  for (const x of syms as Symbol[]) {
    const px = marks.get(x)!.mark!;
    const p = s.ledger.perps.get(x);
    if (p) {
      const r = fillPerp(s.ledger, x, -p.q, px, p.lev, b.rules.feeBps, b.lastValid, b.rules.leverageCap[MARKETS[x].cls] ?? 1n);
      if (r.ok) out.push({ t: "Fill", seat: o.seat, clientId: o.clientId, symbol: x, product: "PERP", dq: -p.q, px, fee: r.fee, realised: r.realised, ts });
    }
    const h = s.ledger.spot.get(x);
    if (h) {
      const r = spotSell(s.ledger, x, h, px, b.rules.feeBps);
      if (r.ok) out.push({ t: "Fill", seat: o.seat, clientId: o.clientId, symbol: x, product: "SPOT", dq: -h, px, fee: r.fee, realised: 0n, ts });
    }
  }
  return "done";
}

/** OPT_BUY at the ask, OPT_SELL (an open long only) at the bid, at the fresh tick's mark; selling respects the hold. */
function option(b: Book, s: SeatState, l: Live, ts: number, S: bigint, out: Emitted[]): "done" {
  const o = l.o;
  const x = o.option!;
  const sym = o.symbol as Symbol;
  const id = seriesId(sym, x.type, x.strike, x.expiry);
  const sigma = b.rules.sigma[sym]!;
  const rej = (reason: Reason): "done" => (out.push({ t: "Reject", seat: o.seat, clientId: o.clientId, reason, ts }), "done");
  if (o.kind === "OPT_BUY") {
    const r = buyOption(s.options, s.ledger.cash, { sym, ...x }, S, sigma, ts, b.rules.stack, b.rules.premiumBudgetBps, b.listed);
    if (!r.ok) return rej(r.reason);
    s.ledger.cash = r.cashAfter!;
    s.lastIncrease.set(id, ts);
    out.push({ t: "OptFill", seat: o.seat, clientId: o.clientId, series: id, contracts: x.contracts, chips: -r.chips, ts });
    return "done";
  }
  if (inHold(b, s, id, ts)) return rej("HOLD");
  const r = sellOption(s.options, id, x.contracts, S, sigma, ts);
  if (!r.ok) return rej(r.reason);
  s.ledger.cash += r.chips;
  out.push({ t: "OptFill", seat: o.seat, clientId: o.clientId, series: id, contracts: -x.contracts, chips: r.chips, ts });
  return "done";
}
