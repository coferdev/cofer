/**
 * What the App shows for one seat and for the marks (spec §6.5 Live, §10.2 `me`, `mark`). Read-only views over the
 * engine's game state: they never change it, so showing a screen can never change a result.
 * Amounts stay bigint here (chips at 1e6, prices and quantities at 1e8); the transport turns them into decimal strings.
 */
import type { Game } from "../engine/game";
import { freeMargin, maintenance, totalMaintenance, unrealised } from "../engine/ledger";
import type { Mark } from "../marks/median";

export interface PositionView {
  symbol: string;
  product: "PERP" | "SPOT";
  qty: bigint; // signed, 1e8
  entry: bigint | null; // 1e8 (perps)
  lev: bigint | null;
  mark: bigint | null;
  upnl: bigint | null; // chips 1e6 (perps)
  mm: bigint | null;
  holdUntil: number | null; // ms: reducing before this is refused (the 60 s minimum hold)
}

export interface OptionView {
  series: string;
  symbol: string;
  type: string;
  strike: bigint;
  expiry: number;
  contracts: bigint;
}

export interface OrderView {
  ref: string;
  kind: string;
  symbol: string;
  product: string;
  side: string | null;
  limitPx: bigint | null;
  triggerPx: bigint | null;
  fired: boolean;
  recvTs: number;
}

export interface SeatView {
  equity: bigint;
  free: bigint;
  mm: bigint;
  /** E < 1.5 × MM: one bad tick from elimination. */
  warn: boolean;
  eliminatedAt: number | null;
  positions: PositionView[];
  options: OptionView[];
  orders: OrderView[];
}

const safe = <T>(f: () => T, d: T): T => {
  try {
    return f();
  } catch {
    return d; // a held symbol with no valid mark yet
  }
};

export function seatView(g: Game, seat: string, now: number): SeatView | null {
  const key = seat.toLowerCase();
  const s = g.book.seats.get(key);
  const sample = g.samples.get(key);
  if (!s || !sample) return null;
  const m = g.book.lastValid;
  const hold = (sym: string) => {
    const t = s.lastIncrease.get(sym);
    return t !== undefined && now < t + g.book.rules.minHoldMs ? t + g.book.rules.minHoldMs : null;
  };
  const positions: PositionView[] = [];
  for (const [sym, p] of [...s.ledger.perps].sort(([a], [b]) => a.localeCompare(b))) {
    const px = m.get(sym) ?? null;
    positions.push({ symbol: sym, product: "PERP", qty: p.q, entry: p.entry, lev: p.lev, mark: px, upnl: px === null ? null : unrealised(p, px), mm: px === null ? null : maintenance(p, px), holdUntil: hold(sym) });
  }
  for (const [sym, h] of [...s.ledger.spot].sort(([a], [b]) => a.localeCompare(b))) {
    if (h === 0n) continue;
    positions.push({ symbol: sym, product: "SPOT", qty: h, entry: null, lev: null, mark: m.get(sym) ?? null, upnl: null, mm: null, holdUntil: hold(sym) });
  }
  const options: OptionView[] = [...s.options].map(([series, o]) => ({ series, symbol: o.sym, type: o.type, strike: o.strike, expiry: o.expiry, contracts: o.contracts }));
  const orders: OrderView[] = g.book.live
    .filter((l) => l.o.seat === key)
    .map((l) => ({ ref: l.o.clientId, kind: l.o.kind, symbol: l.o.symbol, product: l.o.product, side: l.o.side ?? null, limitPx: l.o.limitPx ?? null, triggerPx: l.o.triggerPx ?? null, fired: l.firedAt !== undefined, recvTs: l.recvTs }));
  const mm = safe(() => totalMaintenance(s.ledger, m), 0n);
  const equity = sample.lastEquity;
  return {
    equity, free: safe(() => freeMargin(s.ledger, m), 0n), mm,
    warn: s.ledger.eliminatedAt === null && mm > 0n && equity * 2n < mm * 3n,
    eliminatedAt: s.ledger.eliminatedAt, positions, options, orders,
  };
}

export interface MarkView {
  s: string;
  px: bigint | null;
  status: string;
  /** lighter, arcus, chainlink: 1 when that source is in the median this tick, 0 when stale or excluded. */
  src: [number, number, number];
  ts: number;
}

export function markView(m: Mark, ts: number): MarkView {
  const has = (x: string) => (m.used.includes(x as never) ? 1 : 0);
  return { s: m.symbol, px: m.mark, status: m.status, src: [has("lighter"), has("arcus"), has("chainlink")], ts };
}

/** bigint → decimal string, for JSON on the wire (spec §10: bigint as decimal strings). */
export const wire = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
