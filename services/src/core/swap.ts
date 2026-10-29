/**
 * Group buy/sell planning. A swap proposal's minOut must clear BOTH:
 *   - the pool quote minus the proposer's slippage tolerance (protects the group from moves), and
 *   - the on-chain oracle floor: oracleOut x (1 - pot.maxSlipBps)   (CoferPot reverts otherwise)
 * If the pool quote is already below the oracle floor, the pool is off-price (thin, manipulated,
 * or the market is closed) and we refuse to build the proposal.
 */
import { concat, numberToHex, type Address, type Hex } from "viem";
import { minOutFloor } from "./valuation";

export function encodeV3Path(tokens: Address[], fees: number[]): Hex {
  if (tokens.length !== fees.length + 1 || tokens.length < 2) throw new Error("bad path");
  const parts: Hex[] = [tokens[0]!];
  for (let i = 0; i < fees.length; i++) {
    parts.push(numberToHex(fees[i]!, { size: 3 }));
    parts.push(tokens[i + 1]!);
  }
  return concat(parts);
}

export function swapInAfterFee(amountIn: bigint, feeBps: number): { fee: bigint; swapIn: bigint } {
  const fee = (amountIn * BigInt(feeBps)) / 10_000n;
  return { fee, swapIn: amountIn - fee };
}

export type MinOutResult = { ok: true; minOut: bigint; floor: bigint } | { ok: false; reason: string; floor: bigint };

export function computeMinOut(args: {
  poolOut: bigint; // QuoterV2 for swapIn
  oracleOut: bigint; // CoferFactory.quote for swapIn
  userSlipBps: number; // proposer tolerance vs pool, e.g. 100 = 1%
  potMaxSlipBps: number; // CoferPot config
}): MinOutResult {
  const floor = minOutFloor(args.oracleOut, args.potMaxSlipBps);
  if (args.poolOut < floor) return { ok: false, reason: "pool price is too far from the oracle price", floor };
  const fromPool = (args.poolOut * BigInt(10_000 - args.userSlipBps)) / 10_000n;
  const minOut = fromPool > floor ? fromPool : floor;
  if (minOut === 0n) return { ok: false, reason: "amount too small", floor };
  return { ok: true, minOut, floor };
}
