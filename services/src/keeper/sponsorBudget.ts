/**
 * Sponsorship budget alarm (keeper, hourly): this UTC month's covered network fees (sponsored member actions, from
 * the sponsored actions ledger, worked out from the chain alone) against SPONSOR_MONTHLY_BUDGET_ETH. One staff post
 * at 80% and one at 100% ("sponsor-budget-80", "sponsor-budget-100"), each once a month. Without the setting, off.
 */
import { formatEther } from "viem";
import { checkAlert, type AlertDeps } from "./alerts";

export const BUDGET_STEPS = [80, 100] as const;

export interface SponsorBudgetDeps {
  budgetWei: bigint | null; // SPONSOR_MONTHLY_BUDGET_ETH
  /** Covered network fees (sponsored actions) in this UTC month so far, in wei. */
  spentThisMonth(month: string): Promise<bigint>;
  /** This job's open alert keys (to drop last month's without a post). */
  openKeys(): Promise<string[]>;
  now(): number; // unix seconds
  alerts: AlertDeps;
}

export const monthOf = (t: number) => new Date(t * 1000).toISOString().slice(0, 7);

export async function sponsorBudget(d: SponsorBudgetDeps): Promise<{ month: string; spentBps: number } | null> {
  if (d.budgetWei === null || d.budgetWei <= 0n) return null;
  const month = monthOf(d.now());
  for (const k of await d.openKeys()) if (!k.includes(`:${month}:`)) await d.alerts.close(k); // a new month starts afresh
  const spent = await d.spentThisMonth(month);
  const bps = Number((spent * 10_000n) / d.budgetWei);
  for (const step of BUDGET_STEPS) {
    if (bps < step * 100) continue;
    await checkAlert(`sponsor-budget:${month}:${step}`, { name: `sponsor-budget-${step}`, what: `Covered network fees this month (${month}) have reached ${(bps / 100).toFixed(0)}% of the monthly budget: ${formatEther(spent)} of ${formatEther(d.budgetWei)} ETH, worked out from the chain.`, who: step === 100 ? "Dev checks the paymaster's balance and decides whether to raise the budget." : "Dev checks the trend." }, d.alerts);
  }
  return { month, spentBps: bps };
}
