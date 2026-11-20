/**
 * GET /v1/pots/:pot/fees?after=<block>-<logIndex>&limit=<1..200>: every fee a group account paid (the swap fee on each
 * swap, and each plan payment), oldest first, each with its transaction. From the fee ledger (docs/ledgers.md).
 */
import { getAddress, type Address } from "viem";

export const FEES_CACHE_MS = 15_000;
export const FEES_MAX_LIMIT = 200;

export interface FeesDeps {
  rows(pot: Address, after: { block: bigint; logIndex: number } | null, limit: number): Promise<{ id: string; kind: string; asset: string; amount: string; months: number | null; block: bigint; tx: string }[]>;
  token(a: Address): Promise<{ symbol: string; decimals: number } | null>;
}

export async function readFees(d: FeesDeps, pot: Address, after: { block: bigint; logIndex: number } | null, limit: number) {
  const rows = await d.rows(pot, after, limit);
  const fees = await Promise.all(
    rows.map(async (r) => {
      const t = await d.token(getAddress(r.asset));
      return { kind: r.kind, asset: getAddress(r.asset), symbol: t?.symbol ?? null, decimals: t?.decimals ?? null, amount: r.amount, months: r.months, block: r.block, logIndex: Number(r.id.split(":")[1]), tx: r.tx };
    }),
  );
  const last = fees.at(-1);
  return { pot, fees, next: rows.length === limit && last ? `${last.block}-${last.logIndex}` : null };
}
