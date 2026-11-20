/**
 * The fee ledger (table fees): every fee a group account paid, one row per log: the swap fee from each Swapped log
 * (in the token swapped in) and each plan payment from the group account's PlanPaid log (in USDG). Per group, token
 * and transaction, read from the chain only.
 */
import type { EventIn, Projection } from "./runner";

export interface FeeRow {
  id: string; // txHash:logIndex
  pot: string;
  kind: "swap fee" | "plan";
  asset: string; // the token the fee was paid in
  amount: bigint;
  months: number | null; // plan only
  block: bigint;
  tx: string;
}

export function feesProjection(usdg: string): Projection<FeeRow> {
  return {
    name: "ledger:fees",
    events: ["Swapped", "PlanPaid"],
    reduce(events: EventIn[]): FeeRow[] {
      const out: FeeRow[] = [];
      for (const e of events) {
        const a = e.args as Record<string, string>;
        // the fee router also logs PlanPaid (with a pot field); only the group account's own log counts, once
        if (e.name === "PlanPaid" && "pot" in a) continue;
        const base = { id: `${e.txHash}:${e.logIndex}`, pot: e.address, block: e.block, tx: e.txHash };
        if (e.name === "Swapped") {
          if (BigInt(a.fee!) === 0n) continue;
          out.push({ ...base, kind: "swap fee", asset: a.tokenIn!, amount: BigInt(a.fee!), months: null });
        } else out.push({ ...base, kind: "plan", asset: usdg, amount: BigInt(a.cost!), months: Number(a.months) });
      }
      return out;
    },
  };
}
