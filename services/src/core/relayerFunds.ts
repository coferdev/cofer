/**
 * Relayer ETH check (keeper ops job, every 5 minutes). The relayer only pays gas for permissionless
 * execute() calls, a fraction of a cent each; below the threshold, passed votes may stop executing
 * automatically. Members' own actions (deposit, exit, leave) never use it.
 */
import { formatEther } from "viem";

/** "0.0031", "1.25": ETH cut to 6 decimals, never rounded up. */
export function ethText(wei: bigint): string {
  const [i, f = ""] = formatEther(wei).split(".");
  const frac = f.slice(0, 6).replace(/0+$/, "");
  return frac ? `${i}.${frac}` : i!;
}

/** The alert text while the relayer is below `min`, or null. Shows only its public address. */
export function relayerFundsProblem(address: string, balance: bigint, min: bigint): string | null {
  if (balance >= min) return null;
  return `The relayer's ETH is low: ${ethText(balance)} ETH left (alert below ${ethText(min)} ETH). Send ETH on Robinhood Chain to ${address}. Until then, passed votes may not execute automatically. Members can still exit at any time.`;
}
