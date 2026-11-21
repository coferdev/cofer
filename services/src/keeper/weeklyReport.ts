/**
 * Weekly staff report (keeper; posted once, on Monday, for the week that just ended, Monday 00:00 to Monday 00:00 UTC):
 * counts only. Groups, members, votes run, deposits and exits; alerts open; relayer days left, sponsored member
 * actions, indexer health. No amounts, prices or totals of money.
 */

export interface WeekCounts {
  weekStart: string; // YYYY-MM-DD (a Monday)
  groups: number;
  newGroups: number;
  activeMembers: number;
  votesRun: number;
  deposits: number;
  exits: number;
  allowanceSpends: number;
  alertsOpen: number;
  alertsOpenedThisWeek: number;
  relayerDaysLeft: number | null;
  sponsoredActions: number;
  indexerState: string;
}

export interface WeeklyReportDeps {
  now(): number; // unix seconds
  /** The week start already reported (stored), or null. */
  lastReported(): Promise<string | null>;
  markReported(weekStart: string): Promise<void>;
  counts(weekStart: number, weekEnd: number): Promise<Omit<WeekCounts, "weekStart">>;
  send(text: string): Promise<void>;
}

/** The Monday 00:00 UTC that starts the week before `now`'s week. */
export function lastWeekStart(now: number): number {
  const d = new Date(now * 1000);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  const thisMonday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day) / 1000;
  return thisMonday - 7 * 86_400;
}

export function reportText(c: WeekCounts): string {
  const end = new Date(Date.parse(`${c.weekStart}T00:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10);
  return [
    `Cofer weekly report: ${c.weekStart} to ${end} (UTC)`,
    "",
    `Groups: ${c.groups} (${c.newGroups} new this week)`,
    `Active members: ${c.activeMembers}`,
    `Votes run: ${c.votesRun}`,
    `Deposits: ${c.deposits}`,
    `Exits: ${c.exits}`,
    `Allowance spends: ${c.allowanceSpends}`,
    "",
    `Alerts open now: ${c.alertsOpen} (${c.alertsOpenedThisWeek} of them opened this week)`,
    `Relayer: ${c.relayerDaysLeft === null ? "no recent spend to forecast from" : `about ${c.relayerDaysLeft} days of gas left`}`,
    `Sponsored member actions: ${c.sponsoredActions}`,
    `Indexer: ${c.indexerState}`,
  ].join("\n");
}

/** Posts last week's report once, on Monday (any later run that day or week does nothing). */
export async function weeklyReport(d: WeeklyReportDeps): Promise<string | null> {
  const now = d.now();
  if (new Date(now * 1000).getUTCDay() !== 1) return null;
  const start = lastWeekStart(now);
  const startDay = new Date(start * 1000).toISOString().slice(0, 10);
  if ((await d.lastReported()) === startDay) return null;
  const text = reportText({ weekStart: startDay, ...(await d.counts(start, start + 7 * 86_400)) });
  await d.send(text);
  await d.markReported(startDay);
  return text;
}
