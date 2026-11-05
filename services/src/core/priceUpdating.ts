/**
 * The daily USDG update window (SECURITY.md, accepted risks). USDG's price limit is 24h and the
 * real feed updates every 24h plus up to about 30 seconds, so for a few seconds a day the factory
 * refuses the USDG price (StalePrice). In that case members are told the price is updating, not
 * that the market is closed. Past PRICE_UPDATING_GRACE_SEC it is a real feed problem and the usual
 * text is shown. Used in the browser too: no Node imports.
 */
import { BaseError, ContractFunctionRevertedError, type Address } from "viem";
import { coferFactoryAbi } from "../chain/abi";

export const PRICE_UPDATING_TEXT = "The price is updating, try again in a minute.";
/** How long past its limit the USDG price may be and still count as "updating" (5 minutes). */
export const PRICE_UPDATING_GRACE_SEC = 5 * 60;

/** The asset named by a StalePrice(asset) revert, or undefined for any other error. */
export function stalePriceAsset(e: unknown): Address | undefined {
  if (!(e instanceof BaseError)) return undefined;
  const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
  if (!(r instanceof ContractFunctionRevertedError) || r.data?.errorName !== "StalePrice") return undefined;
  const a = r.data.args?.[0];
  return typeof a === "string" ? (a as Address) : undefined;
}

/** True when the price is past its limit by more than 0 and at most graceSec seconds. */
export function justPastLimit(f: { updatedAt: number; maxStaleness: number }, nowSec: number, graceSec = PRICE_UPDATING_GRACE_SEC): boolean {
  if (f.updatedAt <= 0 || f.updatedAt > nowSec) return false;
  const over = nowSec - f.updatedAt - f.maxStaleness;
  return over > 0 && over <= graceSec;
}

type Reader = {
  readContract(args: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<unknown>;
  getBlock(): Promise<{ timestamp: bigint }>;
};

/**
 * True only when `e` is StalePrice for USDG and USDG is at most PRICE_UPDATING_GRACE_SEC past its
 * limit at the latest block. Any failed read returns false, so the usual text is shown.
 */
export async function isUsdgUpdating(e: unknown, client: Reader, factory: Address, usdg: Address): Promise<boolean> {
  const asset = stalePriceAsset(e);
  if (!asset || asset.toLowerCase() !== usdg.toLowerCase()) return false;
  try {
    const [updatedAt, info, block] = await Promise.all([
      client.readContract({ address: factory, abi: coferFactoryAbi, functionName: "priceUpdatedAt", args: [usdg] }) as Promise<bigint>,
      client.readContract({ address: factory, abi: coferFactoryAbi, functionName: "assetInfo", args: [usdg] }) as Promise<{ maxStaleness: number | bigint }>,
      client.getBlock(),
    ]);
    return justPastLimit({ updatedAt: Number(updatedAt), maxStaleness: Number(info.maxStaleness) }, Number(block.timestamp));
  } catch {
    return false;
  }
}
