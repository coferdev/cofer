/**
 * Price-jump alarm (keeper, every 15 minutes): a staff alert "price-jump-<SYMBOL>" when a price feed's new reading
 * differs from its previous one by more than PRICE_JUMP_STOCK_BPS (Stock Tokens) or PRICE_JUMP_USDG_BPS (USDG).
 * Moves a split explains are left out: the new price is first put on the old multiplier's footing (new answer x old
 * multiplier / new multiplier), and a move that matches a multiplier the issuer has announced is not a jump either.
 * The alert clears at the next quiet reading. Exits never read prices.
 */
import { formatUnits } from "viem";

// The owner's settings.
export const PRICE_JUMP_STOCK_BPS = 2000; // 20%
export const PRICE_JUMP_USDG_BPS = 200; // 2%
export const PENDING_MATCH_BPS = 1500; // an announced multiplier explains a move within 15% of its ratio

export interface PriceReading {
  answer: bigint; // feed answer, raw (8 decimals)
  updatedAt: number; // the feed's own time, unix seconds
  multiplier: bigint; // the token's uiMultiplier (1e18 = 1); 1e18 for USDG
}

const abs = (x: bigint) => (x < 0n ? -x : x);
const movedBps = (from: bigint, to: bigint) => (from === 0n ? Number.POSITIVE_INFINITY : Number((abs(to - from) * 10_000n) / from));

/** The alert text when the move from `prev` to `now` is a jump, else null. */
export function priceJumpProblem(symbol: string, prev: PriceReading, now: PriceReading, o: { usdg: boolean; pendingMultiplier?: bigint | null }): string | null {
  if (now.updatedAt <= prev.updatedAt || prev.answer <= 0n || now.answer <= 0n) return null; // not a new reading
  const limit = o.usdg ? PRICE_JUMP_USDG_BPS : PRICE_JUMP_STOCK_BPS;
  const comparable = now.multiplier > 0n ? (now.answer * prev.multiplier) / now.multiplier : now.answer; // a split's own move removed
  const moved = movedBps(prev.answer, comparable);
  if (moved <= limit) return null;
  if (o.pendingMultiplier && o.pendingMultiplier > 0n) {
    const asIfSplit = (now.answer * prev.multiplier) / o.pendingMultiplier;
    if (movedBps(prev.answer, asIfSplit) <= PENDING_MATCH_BPS) return null; // the announced split explains it
  }
  const p = (x: bigint) => formatUnits(x, 8);
  return `${symbol} price feed moved ${(moved / 100).toFixed(1)}% between two readings (${p(prev.answer)} to ${p(comparable)}${comparable !== now.answer ? " on the same multiplier" : ""}), more than the ${limit / 100}% limit. Deposits and swaps use this price; exits never do.`;
}
