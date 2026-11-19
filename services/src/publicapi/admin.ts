/**
 * GET /v1/admin/pending: every change the factory owner has queued behind the 48-hour timelock and not yet applied
 * (a new price feed, a swap adapter, a new swap fee), in plain words, with the earliest time it can apply; plus the
 * last changes that were applied or replaced. From the pending admin changes ledger (docs/ledgers.md).
 */
import { getAddress, type Address } from "viem";

export const ADMIN_CACHE_MS = 30_000;

export interface AdminRowIn {
  id: string;
  kind: string;
  subject: string;
  newValue: string;
  maxStaleness: number | null;
  eta: number;
  queuedBlock: bigint;
  queuedTx: string;
  state: string;
  resolvedBlock: bigint | null;
  resolvedTx: string | null;
}

export interface AdminDeps {
  /** Queued rows, and the last `recent` applied or replaced ones. */
  rows(recent: number): Promise<AdminRowIn[]>;
  token(a: Address): Promise<{ symbol: string; decimals: number } | null>;
  now(): number; // unix seconds
}

const utc = (t: number) => `${new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
const hrs = (s: number) => `${s / 3600} h`;

export async function describeAdminChange(r: AdminRowIn, token: AdminDeps["token"]): Promise<string> {
  if (r.kind === "swap fee") return `Change the swap fee to ${Number(r.newValue) / 100}%.`;
  if (r.kind === "adapter") return `Turn on swap adapter ${getAddress(r.newValue)}.`;
  const t = await token(getAddress(r.subject));
  return `Use price feed ${getAddress(r.newValue)} for ${t ? `${t.symbol} (${getAddress(r.subject)})` : `token ${getAddress(r.subject)}`}${r.maxStaleness ? `, age limit ${hrs(r.maxStaleness)}` : ""}.`;
}

export async function readAdminPending(d: AdminDeps) {
  const now = d.now();
  const rows = await d.rows(20);
  const one = async (r: AdminRowIn) => ({
    id: r.id,
    kind: r.kind,
    change: await describeAdminChange(r, d.token),
    canApplyAfter: r.eta,
    canApplyAfterUtc: utc(r.eta),
    secondsLeft: Math.max(0, r.eta - now),
    state: r.state,
    queuedBlock: r.queuedBlock,
    queuedTx: r.queuedTx,
    resolvedBlock: r.resolvedBlock,
    resolvedTx: r.resolvedTx,
  });
  return {
    pending: await Promise.all(rows.filter((r) => r.state === "queued").sort((a, b) => a.eta - b.eta).map(one)),
    recent: await Promise.all(rows.filter((r) => r.state !== "queued").map(one)),
  };
}
