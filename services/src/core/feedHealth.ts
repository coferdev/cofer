/**
 * Price-feed health rules (keeper, every 15 minutes). A feed's limit is the factory's maxStaleness
 * for that asset: past it, the contract refuses deposits and swaps that need the price (exits
 * never read feeds). Feeds update on their own rhythm (USDG about every 21-22h against a 1-day
 * limit), so the early warning only fires close to the limit, not at a fraction of it.
 */

import { alertName } from "./alertFormat";

// The owner's setting: log a warning this long before a feed reaches its limit (log only, never posted).
export const FEED_WARN_BEFORE_LIMIT_SEC = 3600; // 1 hour

export interface FeedNow {
  answer: bigint;
  updatedAt: number; // unix seconds
  maxStaleness: number; // seconds, from the factory
}

/** "40m", "25h 10m" (hours and minutes under 2 days), "3d 2h". */
export function ageText(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor((s % 3600) / 60);
  if (s >= 2 * 86400) {
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    return h > 0 ? `${d}d ${h}h` : `${d}d`;
  }
  const h = Math.floor(s / 3600);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

/**
 * Each alert for one feed, with its name, and its text while the problem holds (null when it does not):
 *  - price-bad:   a price the contract rejects (answer <= 0, or a time in the future)
 *  - price-stale: past its limit (deposits and swaps that need it are refused)
 * The early "close to its limit" warning is not an alert (USDG would warn daily): see feedWarning.
 */
export function feedProblems(symbol: string, asset: string, f: FeedNow, now: number) {
  const key = asset.toLowerCase();
  const age = now - f.updatedAt;
  const bad = f.answer <= 0n || f.updatedAt > now;
  const stale = !bad && age > f.maxStaleness;
  return [
    {
      key: `feed-bad:${key}`,
      name: alertName("price-bad", symbol),
      problem: bad ? `${symbol} price feed reports a price the contract rejects. Deposits and swaps that need it are refused until it is fixed. Exits are not affected.` : null,
    },
    {
      key: `feed-stale:${key}`,
      name: alertName("price-stale", symbol),
      problem: stale
        ? `${symbol} price feed is past its limit (${ageText(age)} old, limit ${ageText(f.maxStaleness)}). Deposits and swaps that need it are refused until it updates. Exits are not affected.`
        : null,
    },
  ];
}

/** The early warning, for the log only: within FEED_WARN_BEFORE_LIMIT_SEC of the limit and not yet past it. */
export function feedWarning(symbol: string, f: FeedNow, now: number, warnBeforeSec = FEED_WARN_BEFORE_LIMIT_SEC): string | null {
  const age = now - f.updatedAt;
  if (f.answer <= 0n || f.updatedAt > now || age > f.maxStaleness || age < f.maxStaleness - warnBeforeSec) return null;
  return `${symbol} price feed is close to its limit (${ageText(age)} old, limit ${ageText(f.maxStaleness)}).`;
}

/** The key of the older separate "close to its limit" warning; the keeper removes one left open, without posting. */
export const oldFeedNearKey = (asset: string) => `feed-near:${asset.toLowerCase()}`;
