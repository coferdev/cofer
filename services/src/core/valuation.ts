/**
 * Holdings valuation for display. Robinhood Chain Chainlink equity feeds report
 * "underlying x multiplier" (latestRoundData already includes it), and Stock Token balances are
 * raw (non-rebasing). So:
 *     value      = rawBalance x feedAnswer                (NEVER x uiMultiplier again)
 *     shown qty  = rawBalance x uiMultiplier / 1e18       (display units only)
 * The contract uses the same rule (CoferFactory.quote).
 */

export interface FeedReading {
  answer: bigint;
  decimals: number;
  updatedAt: number; // unix seconds
}

export interface PricedHolding {
  rawBalance: bigint;
  tokenDecimals: number;
  feed: FeedReading;
  uiMultiplier?: bigint; // 1e18-scaled, Stock Tokens only
}

/** Value in USDG base units (6 dp), assuming the USDG feed price `usdgFeed`. Rounds down. */
export function valueInUsdg(h: PricedHolding, usdgFeed: FeedReading, usdgDecimals = 6): bigint {
  if (h.feed.answer <= 0n || usdgFeed.answer <= 0n) throw new Error("bad price");
  const p18 = h.feed.answer * 10n ** BigInt(18 - h.feed.decimals);
  const u18 = usdgFeed.answer * 10n ** BigInt(18 - usdgFeed.decimals);
  const usd18 = (h.rawBalance * p18) / 10n ** BigInt(h.tokenDecimals);
  return (usd18 * 10n ** BigInt(usdgDecimals)) / u18;
}

/** Quantity to show users (e.g. "2.000 TSLA" after a 2:1 split), from raw balance. */
export function displayUnits(rawBalance: bigint, uiMultiplier: bigint = 10n ** 18n): bigint {
  return (rawBalance * uiMultiplier) / 10n ** 18n;
}

/**
 * Continuity check (belt and braces): if a feed jumps by ~the multiplier ratio right when the
 * issuer's multiplier changes, the feed already reflects it; flag anything else for review.
 */
export function multiplierContinuityOk(args: {
  prevAnswer: bigint;
  newAnswer: bigint;
  prevMultiplier: bigint;
  newMultiplier: bigint;
  toleranceBps?: number;
}): boolean {
  const { prevAnswer, newAnswer, prevMultiplier, newMultiplier } = args;
  const tol = BigInt(args.toleranceBps ?? 1500);
  if (prevMultiplier === newMultiplier) return true;
  // expected new feed ~= prev * newMult / prevMult
  const expected = (prevAnswer * newMultiplier) / prevMultiplier;
  const diff = expected > newAnswer ? expected - newAnswer : newAnswer - expected;
  return diff * 10_000n <= expected * tol;
}

export function isStale(feed: FeedReading, maxStalenessSec: number, now: number): boolean {
  return now - feed.updatedAt > maxStalenessSec;
}

/** Oracle floor for a swap's minOut, mirroring CoferPot._swap. */
export function minOutFloor(expectedOut: bigint, maxSlipBps: number): bigint {
  return (expectedOut * BigInt(10_000 - maxSlipBps)) / 10_000n;
}

/** Same formula as CoferFactory.quote (feed-based, decimals-adjusted). */
export function quote(
  amountIn: bigint,
  inp: { feed: FeedReading; tokenDecimals: number },
  out: { feed: FeedReading; tokenDecimals: number },
): bigint {
  const pIn = inp.feed.answer * 10n ** BigInt(18 - inp.feed.decimals);
  const pOut = out.feed.answer * 10n ** BigInt(18 - out.feed.decimals);
  const usd18 = (amountIn * pIn) / 10n ** BigInt(inp.tokenDecimals);
  return (usd18 * 10n ** BigInt(out.tokenDecimals)) / pOut;
}
