/**
 * GET /v1/tx/:hash: a transaction explained in plain words (core/txExplain.ts). A mined receipt never changes, so each
 * explanation is kept (up to TX_CACHE_SIZE, oldest dropped first) and the chain is read once per hash.
 */
import type { Hex } from "viem";
import { explainReceipt, type ExplainDeps, type Explanation, type TxReceiptLike } from "../core/txExplain";

export const TX_CACHE_SIZE = 500;
export const TX_CACHE_SECONDS = 3600;

export interface TxDeps {
  /** The receipt, or null when the chain has no transaction with this hash (yet). */
  receipt(hash: Hex): Promise<TxReceiptLike | null>;
  blockTime(n: bigint): Promise<number>;
  explain: ExplainDeps;
}

export const isTxHash = (s: string): s is Hex => /^0x[0-9a-fA-F]{64}$/.test(s);

export function txExplainer(d: TxDeps) {
  const kept = new Map<string, Explanation>();
  return async (hash: Hex): Promise<Explanation | null> => {
    const k = hash.toLowerCase();
    const hit = kept.get(k);
    if (hit) return hit;
    const r = await d.receipt(hash);
    if (!r) return null;
    const time = await d.blockTime(r.blockNumber).catch(() => null);
    const e = await explainReceipt(r, d.explain, time);
    kept.set(k, e);
    if (kept.size > TX_CACHE_SIZE) kept.delete(kept.keys().next().value!);
    return e;
  };
}
