/**
 * The mark rule (spec §4.2). Pure: the same quotes and tick time always give the same mark, in the engine, the
 * signers and the replay tool.
 *
 *   V = fresh, usable, normalised quotes for the symbol (Lighter, Arcus, Chainlink)
 *   |V| < 2                   -> NO_QUORUM, no mark
 *   max(V)/min(V) - 1 > 1%    -> DIVERGED, no mark
 *   else                      -> median(V) (|V| = 2: floor of the mean), rounded down to the price tick
 *   jump guard: more than 5% from the last valid mark in one tick needs |V| = 3 (all within 1%), else SUSPECT
 */
import { MARKETS, type Symbol } from "./markets";
import { marketOpen } from "./calendar";

export type Source = "lighter" | "arcus" | "chainlink";
export const SOURCE_CODE: Record<Source, number> = { lighter: 1, arcus: 2, chainlink: 3 };
export const SOURCE_BY_CODE: Record<number, Source> = { 1: "lighter", 2: "arcus", 3: "chainlink" };

/** Flags carried on every quote and logged on the tape. */
export const FLAG_OUTSIDE_RTH = 1; // Arcus says the stock is outside regular trading hours
export const FLAG_NOT_ONLINE = 2; // the venue reports the market as not trading
export const FLAG_CORP_ACTION = 4; // Chainlink excluded for the symbol until the next session (multiplier jump)

export type MarkStatus = "OK" | "NO_QUORUM" | "DIVERGED" | "SUSPECT" | "CLOSED";
export const STATUS_CODE: Record<MarkStatus, number> = { OK: 0, NO_QUORUM: 1, DIVERGED: 2, SUSPECT: 3, CLOSED: 4 };

export interface Quote {
  source: Source;
  symbol: Symbol;
  /** Normalised price at 1e8 (Chainlink stock rounds divided by uiMultiplier). */
  px: bigint;
  /** When Cofer received (or re-confirmed unchanged) this quote, ms. */
  recvMs: number;
  /** Venue time if given (ms), or the Chainlink round's updatedAt (s). */
  srcTs: number;
  flags: number;
  /** Chainlink only: the on-chain round as read, so anyone can check it against the chain. */
  round?: { roundId: bigint; answer: bigint; decimals: number; multiplier: bigint };
}

export interface MarkParams {
  maxDivergenceBps: bigint; // 100 = 1%
  jumpGuardBps: bigint; // 500 = 5%
  venueMaxAgeMs: number; // 5,000
  chainlinkMaxAgeSec: number; // 86,400
}

export const DEFAULT_MARK_PARAMS: MarkParams = {
  maxDivergenceBps: 100n,
  jumpGuardBps: 500n,
  venueMaxAgeMs: 5_000,
  chainlinkMaxAgeSec: 86_400,
};

export interface Mark {
  symbol: Symbol;
  status: MarkStatus;
  mark: bigint | null;
  /** Sources that went into V. */
  used: Source[];
  /** Oldest receive time among the Lighter/Arcus quotes in V (the "fresh after the order" check, §4.4). */
  venueFreshFromMs: number | null;
}

/** Is this quote in V at tick time tickMs? */
export function quoteCounts(q: Quote, tickMs: number, p: MarkParams = DEFAULT_MARK_PARAMS): boolean {
  if (q.px <= 0n || q.recvMs > tickMs) return false;
  if (q.flags & FLAG_NOT_ONLINE) return false;
  const stock = MARKETS[q.symbol].cls === "stock";
  if (q.source === "chainlink") {
    if (Math.floor(tickMs / 1000) - q.srcTs > p.chainlinkMaxAgeSec) return false;
    if (stock && (!marketOpen(q.symbol, tickMs) || q.flags & FLAG_CORP_ACTION)) return false;
    return tickMs - q.recvMs <= p.venueMaxAgeMs; // the round must also have been read this tick window
  }
  if (tickMs - q.recvMs > p.venueMaxAgeMs) return false;
  if (q.source === "arcus" && stock && q.flags & FLAG_OUTSIDE_RTH) return false;
  return true;
}

/**
 * One symbol's mark at a tick. `latest` holds at most one quote per source (the newest). `prevValid` is the last
 * valid mark for the jump guard.
 */
export function computeMark(
  symbol: Symbol,
  latest: Quote[],
  tickMs: number,
  prevValid: bigint | null,
  p: MarkParams = DEFAULT_MARK_PARAMS,
): Mark {
  if (!marketOpen(symbol, tickMs)) return { symbol, status: "CLOSED", mark: null, used: [], venueFreshFromMs: null };
  const v = latest.filter((q) => q.symbol === symbol && quoteCounts(q, tickMs, p));
  const used = v.map((q) => q.source);
  const venue = v.filter((q) => q.source !== "chainlink").map((q) => q.recvMs);
  const venueFreshFromMs = venue.length ? Math.min(...venue) : null;
  const none = (status: MarkStatus): Mark => ({ symbol, status, mark: null, used, venueFreshFromMs });

  if (v.length < 2) return none("NO_QUORUM");
  const px = v.map((q) => q.px).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const lo = px[0]!;
  const hi = px[px.length - 1]!;
  if ((hi - lo) * 10_000n > lo * p.maxDivergenceBps) return none("DIVERGED");
  const mid = px.length === 2 ? (px[0]! + px[1]!) / 2n : px[1]!;
  const tick = MARKETS[symbol].tick;
  const mark = mid - (mid % tick);
  if (prevValid !== null && prevValid > 0n) {
    const d = mark > prevValid ? mark - prevValid : prevValid - mark;
    if (d * 10_000n > prevValid * p.jumpGuardBps && v.length !== 3) return none("SUSPECT");
  }
  return { symbol, status: "OK", mark, used, venueFreshFromMs };
}
