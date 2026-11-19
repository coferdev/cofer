/**
 * Set-aside token alarm (keeper, every 30 minutes): a staff alert "set-aside-waiting" for each token that was set
 * aside during an exit more than SET_ASIDE_WAIT_DAYS ago, is still not claimed, and whose claim would now go through
 * (claimOwed simulated with a read-only call, so nothing is sent). Staff can then tell the group: anyone may send the
 * claim, and the tokens always go to the address they were set aside for. The alert clears once the token is claimed
 * (or the claim would fail again).
 */
import { formatUnits, type Address } from "viem";
import { checkAlert, type AlertDeps } from "./alerts";
import { WHO } from "../core/alertFormat";

// The owner's setting.
export const SET_ASIDE_WAIT_DAYS = 7;
export const SET_ASIDE_ALERT = "set-aside-waiting";

export interface SetAsideRow {
  pot: Address;
  asset: Address;
  account: Address;
  open: bigint;
  lastBlock: bigint;
}

export interface SetAsideAlarmDeps {
  /** Ledger rows still open, plus rows with an alert open (so a claimed one can clear). */
  rows(): Promise<SetAsideRow[]>;
  blockTime(n: bigint): Promise<number>;
  /** True when claimOwed(asset, account) on the pot would go through now (a read-only simulation). */
  claimWouldWork(pot: Address, asset: Address, account: Address): Promise<boolean>;
  token(a: Address): Promise<{ symbol: string; decimals: number } | null>;
  now(): number; // unix seconds
  alerts: AlertDeps;
}

export const setAsideKey = (r: Pick<SetAsideRow, "pot" | "asset" | "account">) => `${SET_ASIDE_ALERT}:${r.pot.toLowerCase()}:${r.asset.toLowerCase()}:${r.account.toLowerCase()}`;

export async function setAsideAlarm(d: SetAsideAlarmDeps): Promise<{ open: number; cleared: number }> {
  let open = 0;
  let cleared = 0;
  for (const r of await d.rows()) {
    let problem = null;
    if (r.open > 0n) {
      const age = d.now() - (await d.blockTime(r.lastBlock));
      if (age > SET_ASIDE_WAIT_DAYS * 86_400 && (await d.claimWouldWork(r.pot, r.asset, r.account).catch(() => false))) {
        const t = await d.token(r.asset);
        const amount = t ? `${formatUnits(r.open, t.decimals)} ${t.symbol}` : `${r.open} raw units of token ${r.asset}`;
        problem = {
          name: SET_ASIDE_ALERT,
          what: `${amount} has been set aside for ${r.account} in group account ${r.pot} for ${Math.floor(age / 86_400)} days, and its claim would now go through. Anyone can send the claim (claimOwed); the tokens go to that address.`,
          who: `${WHO.dev} Tell the group, so the owner of that address can claim it (/claim, or GET /v1/set-asides/<address>).`,
        };
      }
    }
    const res = await checkAlert(setAsideKey(r), problem, d.alerts);
    if (res === "opened") open++;
    if (res === "cleared") cleared++;
  }
  return { open, cleared };
}
