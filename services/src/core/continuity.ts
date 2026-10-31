/**
 * Multiplier continuity check (keeper, every 15 minutes, Stock Tokens only).
 *
 * On Robinhood Chain an equity feed already includes the token's multiplier and balances never
 * change, so a split shows up as the feed moving by exactly the multiplier's ratio when
 * uiMultiplier() changes. A move the multiplier does not explain means values may be wrong
 * (a split counted twice or not at all): that is the alert.
 *
 * The keeper keeps the last trusted reading (the base) and compares each new feed price with it:
 *  - no new feed price yet: wait (a feed pauses around a corporate action), keep the base
 *  - expected move = new multiplier / base multiplier; the price must land within the tolerance
 *  - a jump that matches a pending multiplier from the issuer, before it takes effect: wait
 *  - otherwise alert, and keep the base so the alert stays open (no repeats) until feed and
 *    multiplier agree again, or the new level has held for CONTINUITY_ACCEPT_AFTER_SEC
 */
import { formatUnits } from "viem";
import { multiplierToWad } from "../stocks/canonical";

// The owner's settings.
export const CONTINUITY_JUMP_BPS = 3500; // 35%: a move the multiplier does not explain
export const CONTINUITY_SPLIT_TOLERANCE_BPS = 1500; // 15%: around the expected move for a corporate action
export const CORPORATE_ACTION_BPS = 500; // a multiplier change of 5% or more is a corporate action (smaller ones are dividend-sized drift)
export const PENDING_WINDOW_SEC = 6 * 3600; // a pending multiplier still explains a jump until 6h after its effective time
export const CONTINUITY_ACCEPT_AFTER_SEC = 24 * 3600; // an unexplained level that holds this long becomes the new normal

export interface Reading {
  answer: bigint; // feed answer, raw
  updatedAt: number; // the feed's own time, unix seconds
  multiplier: bigint; // token uiMultiplier(), 1e18 = 1
}

export interface Pending {
  multiplier: bigint; // 1e18 = 1, from the issuer API
  effectiveAt: number; // unix seconds
}

export interface ContinuityResult {
  problem: string | null; // alert text while feed and multiplier disagree
  base: Reading; // the reading to keep as trusted
  mismatchSince: number | null;
  accepted?: string; // sent once when an unexplained level is accepted after CONTINUITY_ACCEPT_AFTER_SEC
}

const absDiff = (a: bigint, b: bigint) => (a > b ? a - b : b - a);
/** True if `actual` is within `bps` of `expected`. */
const within = (actual: bigint, expected: bigint, bps: number) => expected > 0n && absDiff(actual, expected) * 10_000n <= expected * BigInt(bps);
/** "2.00", "0.10". */
const ratioText = (num: bigint, den: bigint) => (Number((num * 10_000n) / den) / 10_000).toFixed(2);
/** "1", "1.0008", "2". */
export const multiplierText = (wad: bigint) => String(Number(Number(formatUnits(wad, 18)).toFixed(4)));

function problemText(symbol: string, base: Reading, now: Reading): string {
  const moved = `the price feed moved ${ratioText(now.answer, base.answer)}×`;
  const why = `Values for ${symbol} may be wrong (a split counted twice or not at all). Check before trusting them.`;
  if (now.multiplier === base.multiplier) return `${symbol}: ${moved} but the token's multiplier did not change. ${why}`;
  const m = `${multiplierText(base.multiplier)} → ${multiplierText(now.multiplier)}`;
  return `${symbol}: the multiplier changed ${m} (expected about ${ratioText(now.multiplier, base.multiplier)}×) but ${moved}. ${why}`;
}

export function continuityStep(args: {
  symbol: string;
  base: Reading | null;
  mismatchSince: number | null;
  now: Reading;
  pending: Pending | null;
  nowSec: number;
}): ContinuityResult {
  const { symbol, base, now, pending, nowSec } = args;
  if (!base || base.answer <= 0n || base.multiplier <= 0n) return { problem: null, base: now, mismatchSince: null }; // first reading
  // no new feed price: nothing to judge yet; the base keeps its multiplier, so a split waits for the feed
  if (now.updatedAt === base.updatedAt) return { problem: null, base, mismatchSince: args.mismatchSince };

  const expected = (base.answer * now.multiplier) / base.multiplier;
  const corporateAction = !within(now.multiplier, base.multiplier, CORPORATE_ACTION_BPS);
  if (within(now.answer, expected, corporateAction ? CONTINUITY_SPLIT_TOLERANCE_BPS : CONTINUITY_JUMP_BPS)) {
    return { problem: null, base: now, mismatchSince: null };
  }

  // the feed moved first, by the ratio of a multiplier the issuer has announced: wait for the token
  if (pending && pending.multiplier > 0n && nowSec < pending.effectiveAt + PENDING_WINDOW_SEC) {
    const expectedPending = (base.answer * pending.multiplier) / base.multiplier;
    if (within(now.answer, expectedPending, CONTINUITY_SPLIT_TOLERANCE_BPS)) return { problem: null, base, mismatchSince: null };
  }

  const since = args.mismatchSince ?? nowSec;
  if (nowSec - since >= CONTINUITY_ACCEPT_AFTER_SEC) {
    return {
      problem: null,
      base: now,
      mismatchSince: null,
      accepted: `${symbol}: the new price level has held for 24h, so it is now treated as normal. If ${symbol} had no corporate action, this was a large market move.`,
    };
  }
  return { problem: problemText(symbol, base, now), base, mismatchSince: since };
}

/** The issuer's pending multiplier as saved by the stock refresh; null when nothing is pending or it is unreadable. */
export function pendingFrom(multiplier: string | null, effectiveAt: Date | null): Pending | null {
  if (!multiplier || !effectiveAt) return null;
  try {
    return { multiplier: multiplierToWad(multiplier), effectiveAt: Math.floor(effectiveAt.getTime() / 1000) };
  } catch {
    return null;
  }
}
