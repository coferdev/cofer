/**
 * A vote's summary for the public API, made again from the vote's own bytes (kind and data) with full addresses only.
 * The bot's stored summary can name members by their Telegram usernames, so it is never served publicly; this one
 * cannot contain a name: it is built only from addresses, amounts and numbers in the vote itself.
 */
import { formatUnits, getAddress, type Address, type Hex } from "viem";
import { decodeAction, Kind } from "./proposal";

export type TokenInfo = (a: Address) => Promise<{ symbol: string; decimals: number } | null>;

const pct = (bps: number) => `${bps / 100}%`;
const hrs = (s: number) => {
  const h = s / 3600;
  return `${Number.isInteger(h) ? h : h.toFixed(2)} h`;
};

export async function describePublic(kind: number, data: Hex, usdg: Address, token: TokenInfo): Promise<string> {
  let a;
  try {
    a = decodeAction(kind as Kind, data);
  } catch {
    return `A vote of kind ${kind} whose details could not be read.`;
  }
  const amt = async (t: Address, raw: bigint) => {
    const i = await token(t);
    return i ? `${formatUnits(raw, i.decimals)} ${i.symbol}` : `${raw} raw units of token ${getAddress(t)}`;
  };
  switch (a.kind) {
    case Kind.TRANSFER:
      return `Send ${await amt(a.asset, a.amount)} to ${getAddress(a.to)}.`;
    case Kind.SWAP:
      return `Swap ${await amt(a.tokenIn, a.amountIn)} for at least ${await amt(a.tokenOut, a.minOut)}, through adapter ${getAddress(a.adapter)}.`;
    case Kind.ADD_MEMBER:
      return `Add ${getAddress(a.member)} as a member.`;
    case Kind.REMOVE_MEMBER:
      return `Remove member ${getAddress(a.member)}.`;
    case Kind.SET_ALLOWANCE:
      return `Give ${getAddress(a.member)} an allowance of ${await amt(usdg, a.amount)} every ${hrs(a.period)}.`;
    case Kind.SET_THRESHOLD:
      return a.thresholdBps > 0 ? `Change the vote rule to ${pct(a.thresholdBps)} of members (rounded up).` : `Change the vote rule to ${a.threshold} approval(s).`;
    case Kind.SET_CONFIG:
      return `Change the settings: exit window ${hrs(a.guardDelay)}, swap price limit ${pct(a.maxSlipBps)}, entry spread ${pct(a.entrySpreadBps)}, deposits ${a.depositsOpen ? "open" : "closed"}.`;
    case Kind.PAY_PLAN:
      return `Pay the plan for ${a.months} month(s), at most ${await amt(usdg, a.maxCost)}.`;
  }
}
