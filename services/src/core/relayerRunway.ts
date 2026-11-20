/**
 * The relayer's days left: its gas balance divided by its average daily spend over the last RUNWAY_DAYS days (from the
 * relayer spend ledger). Days only: the balance itself is not shown in public. No spend in that time: null (nothing to
 * forecast). Staff are warned at RUNWAY_WARN_DAYS ("relayer-days-left"); this is an early warning, separate from the
 * relayer-low threshold.
 */

// The owner's settings.
export const RUNWAY_DAYS = 14;
export const RUNWAY_WARN_DAYS = 7;
export const RUNWAY_ALERT = "relayer-days-left";

/** Days left, to one decimal, from the balance and the daily spends of the window (missing days count as 0). */
export function daysLeft(balanceWei: bigint, dailySpendWei: bigint[], windowDays = RUNWAY_DAYS): number | null {
  const total = dailySpendWei.reduce((a, b) => a + b, 0n);
  if (total <= 0n) return null;
  // balance / (total / window), kept in whole numbers until the end
  const tenths = (balanceWei * BigInt(windowDays) * 10n) / total;
  return Number(tenths) / 10;
}

export function runwayProblem(days: number | null): string | null {
  if (days === null || days >= RUNWAY_WARN_DAYS) return null;
  return `At its last ${RUNWAY_DAYS} days' average spend, the relayer has about ${days} days of gas left. Passed votes stop running on their own when it runs out (members can still run them, and exits never need it).`;
}
