/**
 * Nightly reconciliation (keeper, every 24 hours): for every group account, the member shares, the total shares and
 * the token balances are read again from the chain and compared with the database the bot and dashboard show. Any
 * difference opens the staff alert "reconcile-mismatch" with the first one found (and how many there are); a clean
 * pass clears it. Read-only on both sides: nothing is corrected automatically (the replay tool shows how).
 */
import { checkAlert, type AlertDeps } from "./alerts";
import { WHO } from "../core/alertFormat";

export const RECONCILE_ALERT = "reconcile-mismatch";

export interface PotState {
  members: Map<string, { active: boolean; shares: bigint }>; // lower-case address
  totalShares: bigint;
  balances: Map<string, bigint>; // lower-case token
}

export interface ReconcileDeps {
  pots(): Promise<string[]>;
  fromChain(pot: string, members: string[]): Promise<PotState>;
  fromDb(pot: string): Promise<PotState>;
  alerts: AlertDeps;
}

/** Every difference between the chain and the database for one group account, as plain lines. */
export function differences(pot: string, chain: PotState, db: PotState): string[] {
  const out: string[] = [];
  for (const [m, c] of chain.members) {
    const d = db.members.get(m);
    if (!d) {
      if (c.active || c.shares > 0n) out.push(`${pot}: member ${m} is on the chain but not in the database`);
      continue;
    }
    if (d.shares !== c.shares) out.push(`${pot}: member ${m} has ${c.shares} shares on the chain, ${d.shares} in the database`);
    if (d.active !== c.active) out.push(`${pot}: member ${m} is ${c.active ? "active" : "not active"} on the chain, ${d.active ? "active" : "not active"} in the database`);
  }
  const dbTotal = [...db.members.values()].reduce((s, x) => s + x.shares, 0n);
  if (dbTotal !== chain.totalShares) out.push(`${pot}: total shares ${chain.totalShares} on the chain, members add up to ${dbTotal} in the database`);
  for (const [t, c] of chain.balances) {
    const d = db.balances.get(t);
    if (d !== undefined && d !== c) out.push(`${pot}: token ${t} balance ${c} on the chain, ${d} in the database`);
  }
  return out;
}

export async function reconcile(d: ReconcileDeps): Promise<{ pots: number; differences: number }> {
  const all: string[] = [];
  const pots = await d.pots();
  for (const pot of pots) {
    const db = await d.fromDb(pot);
    const chain = await d.fromChain(pot, [...db.members.keys()]);
    all.push(...differences(pot, chain, db));
  }
  await checkAlert(RECONCILE_ALERT, all.length ? { name: RECONCILE_ALERT, what: `The nightly check found ${all.length} difference(s) between the chain and the database. First: ${all[0]}. The chain is right; the bot and dashboard may show old numbers until it is fixed.`, who: `${WHO.dev} Run cofer-ops replay to see what rebuilding the records would change.` } : null, d.alerts, "the chain and the database agree again");
  return { pots: pots.length, differences: all.length };
}
