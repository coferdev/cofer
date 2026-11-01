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

/** The slip= the bot suggests for a swap that will wait the exit window (capped at the group's limit). */
export const QUEUED_SLIP_SUGGESTION_BPS = 200;

const pctText = (bps: number) => `${bps / 100}%`;

/**
 * Note added to a swap proposal (audit H-2): unless every member signs, a swap waits the group's exit
 * window, and the price can move meanwhile. Suggests a higher slip= when the proposer's is below
 * min(2%, the group's limit). null when the group has no exit window.
 */
export function queuedSwapNote(a: { side: "buy" | "sell"; guardDelaySec: number; slipBps: number; maxSlipBps: number }): string | null {
  if (a.guardDelaySec <= 0) return null;
  const hours = a.guardDelaySec % 3600 === 0 ? `${a.guardDelaySec / 3600} hour${a.guardDelaySec === 3600 ? "" : "s"}` : `${Math.ceil(a.guardDelaySec / 60)} minutes`;
  let note =
    `Unless every member signs, this ${a.side} waits the group's exit window (${hours}) before it runs, so anyone who disagrees can /exit first. ` +
    `If the price moves more than ${pctText(a.slipBps)} (your slip) in that time, it fails and needs a new vote.`;
  const suggest = Math.min(QUEUED_SLIP_SUGGESTION_BPS, a.maxSlipBps);
  if (a.slipBps < suggest) note += ` For more room, propose again with slip=${suggest / 100} (this group allows up to ${pctText(a.maxSlipBps)}).`;
  return note;
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
