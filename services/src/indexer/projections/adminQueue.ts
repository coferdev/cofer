/**
 * The pending admin changes ledger (table pending_admin_changes): every change the factory owner queued behind the
 * 48-hour timelock (a price feed, a swap adapter, the swap fee), the earliest time it can apply, and what became of
 * it: applied, replaced by a newer queued change for the same thing, or still queued.
 *   FeedQueued -> FeedApplied (same asset); AdapterQueued -> AdapterSet(allowed) (same adapter); SwapFeeQueued ->
 *   SwapFeeSet. Only factory events count (the table is filled from the factory's own logs).
 */
import type { EventIn, Projection } from "./runner";

export type AdminKind = "feed" | "adapter" | "swap fee";

export interface QueuedChange {
  id: string; // queue log: txHash:logIndex
  kind: AdminKind;
  subject: string; // the asset (feed), the adapter, or "swap fee"
  newValue: string; // the new feed address, the adapter, or the fee in basis points
  maxStaleness: number | null; // feed only: its age limit in seconds
  eta: number; // unix seconds: the earliest time it can apply
  queuedBlock: bigint;
  queuedTx: string;
}

export type AdminOp = { op: "queue"; change: QueuedChange } | { op: "apply"; kind: AdminKind; subject: string; block: bigint; tx: string };

export function adminQueueProjection(factory: string): Projection<AdminOp> {
  const f = factory.toLowerCase();
  return {
    name: "ledger:pending_admin_changes",
    events: ["FeedQueued", "FeedApplied", "AdapterQueued", "AdapterSet", "SwapFeeQueued", "SwapFeeSet"],
    reduce(events: EventIn[]): AdminOp[] {
      const ops: AdminOp[] = [];
      for (const e of events) {
        if (e.address.toLowerCase() !== f) continue;
        const a = e.args as Record<string, string | number | boolean>;
        const id = `${e.txHash}:${e.logIndex}`;
        const q = (kind: AdminKind, subject: string, newValue: string, maxStaleness: number | null) =>
          ops.push({ op: "queue", change: { id, kind, subject: subject.toLowerCase() === "swap fee" ? "swap fee" : subject, newValue, maxStaleness, eta: Number(a.eta), queuedBlock: e.block, queuedTx: e.txHash } });
        const done = (kind: AdminKind, subject: string) => ops.push({ op: "apply", kind, subject, block: e.block, tx: e.txHash });
        switch (e.name) {
          case "FeedQueued":
            q("feed", String(a.asset), String(a.feed), Number(a.maxStaleness));
            break;
          case "FeedApplied":
            done("feed", String(a.asset));
            break;
          case "AdapterQueued":
            q("adapter", String(a.adapter), String(a.adapter), null);
            break;
          case "AdapterSet":
            if (a.allowed === true || a.allowed === "true") done("adapter", String(a.adapter));
            break;
          case "SwapFeeQueued":
            q("swap fee", "swap fee", String(a.bps), null);
            break;
          case "SwapFeeSet":
            done("swap fee", "swap fee");
            break;
        }
      }
      return ops;
    },
  };
}

export interface AdminRow extends QueuedChange {
  state: "queued" | "applied" | "replaced";
  resolvedBlock: bigint | null;
  resolvedTx: string | null;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Applies the operations to an in-memory ledger, in order (the database writer does the same in SQL). */
export function applyAdminOps(rows: AdminRow[], ops: AdminOp[]): AdminRow[] {
  for (const o of ops) {
    if (o.op === "queue") {
      if (rows.some((r) => r.id === o.change.id)) continue;
      for (const r of rows) if (r.state === "queued" && r.kind === o.change.kind && same(r.subject, o.change.subject)) Object.assign(r, { state: "replaced", resolvedBlock: o.change.queuedBlock, resolvedTx: o.change.queuedTx });
      rows.push({ ...o.change, state: "queued", resolvedBlock: null, resolvedTx: null });
    } else {
      const r = rows.filter((x) => x.state === "queued" && x.kind === o.kind && same(x.subject, o.subject)).at(-1);
      if (r) Object.assign(r, { state: "applied", resolvedBlock: o.block, resolvedTx: o.tx });
    }
  }
  return rows;
}
