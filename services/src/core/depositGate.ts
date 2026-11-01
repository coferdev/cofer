/**
 * Deposit price-age gate (audit M-1). CoferPot refuses a deposit while any held non-USDG asset's feed
 * is older than MAX_DEPOSIT_PRICE_AGE (12h): typically nights, weekends and holidays, when the stock
 * market is closed but the tokens still trade. The bot and the signer page check the same rule first,
 * so members see why before anything is signed. Used in the browser too: no Node imports.
 */
import type { Address } from "viem";
import { coferFactoryAbi, coferPotAbi } from "../chain/abi";

export const DEPOSITS_CLOSED_TEXT = "Deposits are closed until the stock price updates (markets closed). Exiting is always open.";

export interface HeldPrice {
  asset: Address;
  distributable: bigint;
  updatedAt: number; // the asset's feed time (seconds)
}

/** The asset whose price is too old for a deposit, or null if deposits may go ahead. Mirrors CoferPot._requireFreshPrices. */
export function stalestForDeposit(held: HeldPrice[], nowSec: number, maxAgeSec: number): { asset: Address; ageSec: number } | null {
  for (const h of held) {
    if (h.distributable === 0n) continue;
    const ageSec = nowSec - h.updatedAt;
    if (ageSec > maxAgeSec) return { asset: h.asset, ageSec };
  }
  return null;
}

type Reader = {
  readContract(args: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<unknown>;
  getBlock(): Promise<{ timestamp: bigint }>;
};

/** Reads the chain (pot, factory, latest block time) and applies the rule. Throws on a failed read. */
export async function readDepositGate(client: Reader, pot: Address, factory: Address): Promise<{ asset: Address; ageSec: number } | null> {
  const [held, maxAge, block] = await Promise.all([
    client.readContract({ address: pot, abi: coferPotAbi, functionName: "heldAssets" }) as Promise<readonly Address[]>,
    client.readContract({ address: pot, abi: coferPotAbi, functionName: "MAX_DEPOSIT_PRICE_AGE" }) as Promise<number | bigint>,
    client.getBlock(),
  ]);
  const others = held.slice(1); // held[0] is USDG, which is never age-checked here
  const rows = await Promise.all(
    others.map(async (asset) => {
      const [distributable, updatedAt] = await Promise.all([
        client.readContract({ address: pot, abi: coferPotAbi, functionName: "distributable", args: [asset] }) as Promise<bigint>,
        client.readContract({ address: factory, abi: coferFactoryAbi, functionName: "priceUpdatedAt", args: [asset] }) as Promise<bigint>,
      ]);
      return { asset, distributable, updatedAt: Number(updatedAt) };
    }),
  );
  return stalestForDeposit(rows, Number(block.timestamp), Number(maxAge));
}
