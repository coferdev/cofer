/**
 * The relayer spend ledger (table relayer_spend): the gas cost of every passed vote the relayer ran (an execute()
 * transaction sent from the relayer's address), one row per transaction, with its UTC day. Read from the chain: the
 * transactions behind ProposalExecuted logs, kept only when the relayer sent them (a member can run a vote too).
 */
import type { Address } from "viem";
import type { EventIn } from "./runner";

export const RELAYER_SPEND = "ledger:relayer_spend";

export interface SpendRow {
  tx: string;
  block: bigint;
  day: string; // YYYY-MM-DD UTC
  gasUsed: bigint;
  gasPrice: bigint; // effective, wei
  costWei: bigint;
}

export interface SpendReader {
  receipt(tx: string): Promise<{ from: string; gasUsed: bigint; effectiveGasPrice: bigint; blockNumber: bigint }>;
  blockTime(n: bigint): Promise<number>;
}

/** The rows for these ProposalExecuted logs: one per transaction the relayer sent. */
export async function relayerSpendRows(evs: EventIn[], relayer: Address, r: SpendReader): Promise<SpendRow[]> {
  const out: SpendRow[] = [];
  const seen = new Set<string>();
  for (const e of evs) {
    if (e.name !== "ProposalExecuted" || seen.has(e.txHash.toLowerCase())) continue;
    seen.add(e.txHash.toLowerCase());
    const rc = await r.receipt(e.txHash);
    if (rc.from.toLowerCase() !== relayer.toLowerCase()) continue;
    const t = await r.blockTime(rc.blockNumber);
    out.push({ tx: e.txHash, block: rc.blockNumber, day: new Date(t * 1000).toISOString().slice(0, 10), gasUsed: rc.gasUsed, gasPrice: rc.effectiveGasPrice, costWei: rc.gasUsed * rc.effectiveGasPrice });
  }
  return out;
}

/** Spend per UTC day from the rows (for the forecast and reports). */
export function spendByDay(rows: Pick<SpendRow, "day" | "costWei">[]): Map<string, bigint> {
  const m = new Map<string, bigint>();
  for (const r of rows) m.set(r.day, (m.get(r.day) ?? 0n) + r.costWei);
  return m;
}
