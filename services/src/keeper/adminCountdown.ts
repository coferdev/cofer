/**
 * Admin change countdown (keeper, every 5 minutes): for each change still queued behind the factory's 48-hour
 * timelock (the pending admin changes ledger), one staff post ADMIN_SOON_HOURS before it can apply
 * ("admin-change-soon") and one when it can apply ("admin-change-due"). Each is posted once; both are dropped
 * without a post once the change is applied or replaced (the applied change itself is posted by the existing
 * admin-change alert).
 */
import { getAddress, type Address } from "viem";
import { checkAlert, type AlertDeps } from "./alerts";
import { WHO } from "../core/alertFormat";

// The owner's setting.
export const ADMIN_SOON_HOURS = 6;
export const SOON_ALERT = "admin-change-soon";
export const DUE_ALERT = "admin-change-due";

export interface QueuedAdminRow {
  id: string;
  kind: string;
  subject: string;
  newValue: string;
  maxStaleness: number | null;
  eta: number;
}

export interface AdminCountdownDeps {
  queued(): Promise<QueuedAdminRow[]>;
  /** Ids of changes this job has alerts open for (to drop the ones no longer queued). */
  openIds(): Promise<string[]>;
  token(a: Address): Promise<{ symbol: string } | null>;
  now(): number; // unix seconds
  alerts: AlertDeps;
}

const utc = (t: number) => `${new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;

async function what(r: QueuedAdminRow, token: AdminCountdownDeps["token"]): Promise<string> {
  if (r.kind === "swap fee") return `the swap fee change to ${Number(r.newValue) / 100}%`;
  if (r.kind === "adapter") return `turning on swap adapter ${getAddress(r.newValue)}`;
  const t = await token(getAddress(r.subject));
  return `the new price feed ${getAddress(r.newValue)} for ${t?.symbol ?? getAddress(r.subject)}${r.maxStaleness ? ` (age limit ${r.maxStaleness / 3600} h)` : ""}`;
}

export async function adminCountdown(d: AdminCountdownDeps): Promise<{ soon: number; due: number; dropped: number }> {
  const now = d.now();
  const rows = await d.queued();
  let soon = 0;
  let due = 0;
  for (const r of rows) {
    const left = r.eta - now;
    if (left <= ADMIN_SOON_HOURS * 3600 && left > 0) {
      if ((await checkAlert(`${SOON_ALERT}:${r.id}`, { name: SOON_ALERT, what: `In ${Math.ceil(left / 3600)} hour(s), at ${utc(r.eta)}, the owner can apply ${await what(r, d.token)}. Members can check it at /v1/admin/pending.`, who: WHO.none }, d.alerts)) === "opened") soon++;
    }
    if (left <= 0) {
      if ((await checkAlert(`${DUE_ALERT}:${r.id}`, { name: DUE_ALERT, what: `The owner can now apply ${await what(r, d.token)} (its timelock ended at ${utc(r.eta)}).`, who: WHO.none }, d.alerts)) === "opened") due++;
    }
  }
  // a change applied or replaced: its countdown alerts are dropped without a post
  const still = new Set(rows.map((r) => r.id));
  let dropped = 0;
  for (const id of await d.openIds())
    if (!still.has(id)) {
      await d.alerts.close(`${SOON_ALERT}:${id}`);
      await d.alerts.close(`${DUE_ALERT}:${id}`);
      dropped++;
    }
  return { soon, due, dropped };
}
