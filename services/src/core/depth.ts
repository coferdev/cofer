/**
 * Pool-depth rule. A Uniswap pool is deep enough if a trade of the test size gets within
 * DEPTH_MAX_GAP_BPS of the Chainlink price, the pool's own fee included.
 *  - listing (scripts/build-asset-list.ts): DEPTH_TEST_USDG, buying and selling
 *  - /buy: max(trade, DEPTH_TEST_USDG)
 *  - /sell: the actual sale size, so a group is never stuck holding a stock because a pool got
 *    thinner; the pot's on-chain oracle floor still bounds every sell
 */
import { formatUnits } from "viem";

// The owner's two settings.
export const DEPTH_TEST_USDG = 10_000_000_000n; // 10,000 USDG (6 decimals)
export const DEPTH_MAX_GAP_BPS = 200; // 2%

export type Side = "buy" | "sell";

/** True if the pool pays at least (1 - maxGap) of the oracle amount. Fails closed on a zero oracle. */
export function passesDepth(poolOut: bigint, oracleOut: bigint, maxGapBps = DEPTH_MAX_GAP_BPS): boolean {
  if (oracleOut <= 0n) return false;
  return poolOut * 10_000n >= oracleOut * BigInt(10_000 - maxGapBps);
}

/** Size to test a pool at for a vote: buys at least DEPTH_TEST_USDG, sells at their own size. */
export function depthTestSize(side: Side, swapIn: bigint): bigint {
  return side === "buy" && swapIn < DEPTH_TEST_USDG ? DEPTH_TEST_USDG : swapIn;
}

/** Pool result vs oracle in bps (negative = the pool pays less), for reports. */
export function gapBps(poolOut: bigint, oracleOut: bigint): number {
  if (oracleOut <= 0n) return -10_000;
  return Number(((poolOut - oracleOut) * 10_000n) / oracleOut);
}

const pct = (bps: number) => `${bps / 100}%`;

/** What members read when no pool passes. */
export function depthRefusal(side: Side): string {
  return side === "buy"
    ? `No Uniswap pool for this stock is deep enough right now: a ${formatUnits(DEPTH_TEST_USDG, 6)} USDG trade must stay within ${pct(DEPTH_MAX_GAP_BPS)} of the market price.`
    : `No Uniswap pool can take this sale within ${pct(DEPTH_MAX_GAP_BPS)} of the market price right now. Try selling a smaller part, for example 25%.`;
}
