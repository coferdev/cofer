/**
 * The game fold (spec §4.0, §4.1): step(state, event) → emitted[]. Events are the logged OrderIn (with its engine
 * receive time) and Tick (with the marks computed from the tape). Each tick runs, in this order:
 *   1. due fills (orders.ts, in log seq order);
 *   2. option listings and expiries (settlement at the first valid mark at or after τ within 300 s, else the last
 *      valid mark at or before τ);
 *   3. elimination checks (E ≤ ΣMM, options counted at bid);
 *   4. equity and drawdown sampling, fills and time with exposure (the activity rule).
 * No wall clock, no floats, no randomness: replaying the same log gives the same state and the same events.
 */
import { MARKETS, type Symbol } from "../marks/markets";
import type { Mark } from "../marks/median";
import { type Seat as Ledger, equity, eliminate, notionalDown, totalMaintenance } from "./ledger";
import type { SeatTrace } from "../scoring/collusion";
import { optionValue, expiries, settle, SETTLE_WAIT_MS } from "./options";
import { type Book, type Emitted, type Order, type Rules, addSeat, delistExpiry, ingest, listExpiry, newBook, onTick } from "./orders";
import { sessionOnDay } from "../marks/calendar";

const HOUR = 3_600_000;

export interface Sample {
  peak: bigint;
  maxDdBps: bigint; // rounded up (against the player)
  fills: number;
  exposedMs: number;
  lastEquity: bigint;
}

interface Expiry {
  sym: Symbol;
  at: number;
  listFrom: number; // listed at the first valid tick at or after this
  listed: boolean;
  settled: boolean;
}

export interface Game {
  book: Book;
  seats: string[]; // seat index order (the tie-break)
  startAt: number;
  endAt: number;
  expiries: Expiry[];
  samples: Map<string, Sample>;
  lastTs: number | null;
  lastValidAt: Map<string, { ts: number; px: bigint }[]>; // recent valid marks per symbol (settlement lookback)
  /** Collusion inputs (spec §4.10): one sample a minute, every opening fill, what was held at elimination. */
  traces: Map<string, SeatTrace>;
  closed: boolean;
}

export type GameEvent =
  | { t: "OrderIn"; seq: number; recvTs: number; order: Order }
  | { t: "Tick"; seq: number; ts: number; marks: Map<string, Mark> };

export type GameEmitted =
  | Emitted
  | { t: "OptionList"; sym: Symbol; expiry: number; series: string[]; ts: number }
  | { t: "OptionSettle"; sym: Symbol; expiry: number; px: bigint; credits: [string, bigint][]; ts: number }
  | { t: "Eliminate"; seat: string; ts: number; equityBefore: bigint };

/** When an expiry is listed: hourly crypto ones 1 h before, the 4 h ones 4 h before, stock session closes at that
 *  session's open, game end at game start; never before the game starts. */
function listFrom(sym: Symbol, at: number, startAt: number, endAt: number): number {
  let from: number;
  if (at === endAt) from = startAt;
  else if (MARKETS[sym].cls === "crypto") from = at - (new Date(at).getUTCHours() % 4 === 0 ? 4 * HOUR : HOUR);
  else from = sessionOnDay(at - 1)?.openMs ?? startAt;
  return from < startAt ? startAt : from;
}

export function newGame(rules: Rules, seats: string[], startAt: number, endAt: number): Game {
  const book = newBook(rules);
  const samples = new Map<string, Sample>();
  for (const s of seats) {
    addSeat(book, s);
    samples.set(s, { peak: rules.stack, maxDdBps: 0n, fills: 0, exposedMs: 0, lastEquity: rules.stack });
  }
  const ex: Expiry[] = [];
  for (const sym of rules.optionMarkets.filter((x) => rules.markets.includes(x)).sort()) {
    for (const at of expiries(sym, startAt, endAt)) ex.push({ sym, at, listFrom: listFrom(sym, at, startAt, endAt), listed: false, settled: false });
  }
  const traces = new Map<string, SeatTrace>(seats.map((seat) => [seat, { seat, samples: [], opens: [], eliminatedAt: null }]));
  return { book, seats: [...seats], startAt, endAt, expiries: ex, samples, lastTs: null, lastValidAt: new Map(), traces, closed: false };
}

export function step(g: Game, ev: GameEvent): GameEmitted[] {
  if (g.closed) return [];
  if (ev.t === "OrderIn") {
    if (ev.recvTs < g.startAt || ev.recvTs >= g.endAt) return [{ t: "Reject", seat: ev.order.seat, clientId: ev.order.clientId, reason: "EXPIRED", ts: ev.recvTs }];
    return ingest(g.book, ev.order, ev.recvTs, ev.seq);
  }
  const ts = ev.ts;
  if (g.lastTs !== null && ts <= g.lastTs) throw new Error("ticks must move forward");
  const out: GameEmitted[] = [];
  for (const [sym, m] of ev.marks) {
    if (m.status !== "OK" || m.mark === null) continue;
    const h = g.lastValidAt.get(sym) ?? [];
    h.push({ ts, px: m.mark });
    while (h.length > 1 && h[0]!.ts < ts - 2 * SETTLE_WAIT_MS) h.shift();
    g.lastValidAt.set(sym, h);
  }

  // 1. fills
  const fills = onTick(g.book, ts, ev.marks);
  for (const e of fills) {
    if (e.t === "Fill" || e.t === "OptFill") g.samples.get(e.seat)!.fills++;
    if (e.t === "Fill") {
      const l = g.book.seats.get(e.seat)!.ledger;
      const qNew = e.product === "PERP" ? (l.perps.get(e.symbol)?.q ?? 0n) : (l.spot.get(e.symbol) ?? 0n);
      const qOld = qNew - e.dq;
      if (abs(qNew) > abs(qOld)) g.traces.get(e.seat)!.opens.push({ ts, symbol: e.symbol, sign: e.dq > 0n ? 1 : -1 });
    }
  }
  out.push(...fills);

  // 2. listings and expiries
  for (const x of g.expiries) {
    const m = ev.marks.get(x.sym);
    const valid = m?.status === "OK" && m.mark !== null;
    if (!x.listed && valid && ts >= x.listFrom && ts < x.at) {
      x.listed = true;
      out.push({ t: "OptionList", sym: x.sym, expiry: x.at, series: listExpiry(g.book, x.sym, x.at, m!.mark!), ts });
    }
    if (ts >= x.at) delistExpiry(g.book, x.sym, x.at);
    if (!x.settled && ts >= x.at) {
      let px: bigint | null = null;
      if (valid && ts <= x.at + SETTLE_WAIT_MS) px = m!.mark!;
      else if (ts > x.at + SETTLE_WAIT_MS) px = lastAtOrBefore(g, x.sym, x.at);
      if (px !== null) out.push(settleExpiry(g, x, px, ts));
    }
  }

  // 3. eliminations
  const val = g.book.lastValid;
  for (const seat of g.seats) {
    const s = g.book.seats.get(seat)!;
    if (s.ledger.eliminatedAt !== null || s.ledger.perps.size === 0) continue;
    if ([...s.ledger.perps.keys()].some((k) => !val.has(k))) continue;
    const ov = optionValue(s.options, val, sigmas(g), ts);
    if (equity(s.ledger, val, ov) > totalMaintenance(s.ledger, val)) continue;
    const tr = g.traces.get(seat)!;
    tr.eliminatedAt = ts;
    tr.heldAtElimination = signedNotional(s.ledger, val);
    s.ledger.cash += ov; // options sold at bid
    s.options.clear();
    const before = eliminate(s.ledger, val, ts) + ov;
    g.book.live = g.book.live.filter((l) => l.o.seat !== seat);
    out.push({ t: "Eliminate", seat, ts, equityBefore: before });
  }

  // 4. sampling
  const dt = g.lastTs === null ? 0 : ts - g.lastTs;
  for (const seat of g.seats) sample(g, seat, ts, dt);
  g.lastTs = ts;
  return out;
}

const abs = (v: bigint) => (v < 0n ? -v : v);

/** Signed notional per symbol at the marks, chips (perps by sign, spot long). */
function signedNotional(l: Ledger, val: Map<string, bigint>): Map<string, bigint> {
  const x = new Map<string, bigint>();
  for (const [sym, p] of l.perps) {
    const px = val.get(sym);
    if (px !== undefined && p.q !== 0n) x.set(sym, (p.q < 0n ? -1n : 1n) * notionalDown(p.q, px));
  }
  for (const [sym, h] of l.spot) {
    const px = val.get(sym);
    if (px !== undefined && h !== 0n) x.set(sym, (x.get(sym) ?? 0n) + notionalDown(h, px));
  }
  return x;
}

const sigmas = (g: Game) => new Map(Object.entries(g.book.rules.sigma) as [string, bigint][]);

function lastAtOrBefore(g: Game, sym: string, at: number): bigint | null {
  let px: bigint | null = null;
  for (const h of g.lastValidAt.get(sym) ?? []) if (h.ts <= at) px = h.px;
  return px ?? g.book.lastValid.get(sym) ?? null;
}

function settleExpiry(g: Game, x: Expiry, px: bigint, ts: number): GameEmitted {
  x.settled = true;
  const credits: [string, bigint][] = [];
  for (const seat of g.seats) {
    const s = g.book.seats.get(seat)!;
    const paid = settle(s.options, x.sym, x.at, px);
    if (paid > 0n) credits.push([seat, paid]);
    s.ledger.cash += paid;
  }
  return { t: "OptionSettle", sym: x.sym, expiry: x.at, px, credits, ts };
}

function seatEquity(g: Game, seat: string, ts: number): bigint {
  const s = g.book.seats.get(seat)!;
  const val = g.book.lastValid;
  for (const k of [...s.ledger.perps.keys(), ...s.ledger.spot.keys()]) if (!val.has(k)) return s.ledger.cash; // cannot happen after a fill
  return equity(s.ledger, val, optionValue(s.options, val, sigmas(g), ts));
}

function sample(g: Game, seat: string, ts: number, dt: number) {
  const s = g.book.seats.get(seat)!;
  const a = g.samples.get(seat)!;
  if (s.ledger.eliminatedAt !== null && s.ledger.eliminatedAt < ts) return;
  const e = seatEquity(g, seat, ts);
  a.lastEquity = e;
  if (ts % 60_000 === 0) g.traces.get(seat)!.samples.push({ ts, equity: e, x: signedNotional(s.ledger, g.book.lastValid) });
  if (e > a.peak) a.peak = e;
  if (a.peak > 0n) {
    const num = (a.peak - (e < 0n ? 0n : e)) * 10_000n;
    const dd = (num + a.peak - 1n) / a.peak;
    if (dd > a.maxDdBps) a.maxDdBps = dd;
  }
  if (s.ledger.perps.size + s.ledger.spot.size + s.options.size > 0) a.exposedMs += dt;
}

/**
 * Game end: every perp and spot position closes at the last valid mark (the hold does not apply, no fee), options
 * expiring at game end settle at that mark and any others are valued at bid and paid out. Returns final equity.
 */
export function finish(g: Game, ts: number): Map<string, bigint> {
  const val = g.book.lastValid;
  for (const x of g.expiries) if (!x.settled && x.at <= g.endAt) {
    const px = lastAtOrBefore(g, x.sym, x.at);
    if (px !== null) settleExpiry(g, x, px, ts);
  }
  const res = new Map<string, bigint>();
  for (const seat of g.seats) {
    const s = g.book.seats.get(seat)!;
    if (s.ledger.eliminatedAt === null) {
      const ov = optionValue(s.options, val, sigmas(g), ts);
      s.ledger.cash += ov;
      s.options.clear();
      const e = equity(s.ledger, val);
      s.ledger.cash = e;
      s.ledger.perps.clear();
      s.ledger.spot.clear();
      const a = g.samples.get(seat)!;
      a.lastEquity = e;
      if (a.peak > 0n) {
        const dd = ((a.peak - (e < 0n ? 0n : e)) * 10_000n + a.peak - 1n) / a.peak;
        if (dd > a.maxDdBps) a.maxDdBps = dd;
      }
    }
    res.set(seat, s.ledger.cash);
  }
  g.book.live = [];
  g.closed = true;
  return res;
}
