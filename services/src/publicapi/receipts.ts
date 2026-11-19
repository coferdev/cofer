/**
 * GET /v1/receipts/<kind>/:tx: a receipt for one Cofer action, with the exact commands to check each figure
 * (core/receipts.ts). A mined transaction never changes, so each receipt is kept once made.
 */
import type { Hex } from "viem";
import { depositReceipt, exitReceipt, type ReceiptDeps } from "../core/receipts";
import type { TxReceiptLike } from "../core/txExplain";

export const RECEIPT_CACHE_SIZE = 500;
export const RECEIPT_CACHE_SECONDS = 3600;

export interface ReceiptsDeps extends ReceiptDeps {
  usdg: `0x${string}`;
  receipt(hash: Hex): Promise<TxReceiptLike | null>;
}

const BUILDERS = { exit: exitReceipt, deposit: depositReceipt } as const;
export type ReceiptKind = keyof typeof BUILDERS;

export function receiptMaker(d: ReceiptsDeps) {
  const kept = new Map<string, unknown>();
  /** The receipt, "none" when the transaction has no such action, or null when the transaction is unknown. */
  return async (kind: ReceiptKind, hash: Hex): Promise<unknown> => {
    const k = `${kind}:${hash.toLowerCase()}`;
    if (kept.has(k)) return kept.get(k);
    const r = await d.receipt(hash);
    if (!r) return null;
    const out = (await BUILDERS[kind](r, d)) ?? "none";
    kept.set(k, out);
    if (kept.size > RECEIPT_CACHE_SIZE) kept.delete(kept.keys().next().value!);
    return out;
  };
}
