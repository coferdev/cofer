import { describe, expect, test } from "bun:test";
import { lastWeekStart, reportText, weeklyReport, type WeekCounts } from "../src/keeper/weeklyReport";
import { telegramProblem } from "./strictTelegram";

const WEEK: Omit<WeekCounts, "weekStart"> = { groups: 12, newGroups: 2, activeMembers: 41, votesRun: 17, deposits: 23, exits: 3, allowanceSpends: 9, alertsOpen: 1, alertsOpenedThisWeek: 1, relayerDaysLeft: 18.5, sponsoredActions: 64, indexerState: "live (2 s behind)" };
const MONDAY = Date.parse("2026-12-07T09:00:00Z") / 1000;

describe("weekly staff report", () => {
  test("last week runs Monday to Monday, UTC", () => {
    expect(new Date(lastWeekStart(MONDAY) * 1000).toISOString()).toBe("2026-11-30T00:00:00.000Z");
    expect(new Date(lastWeekStart(Date.parse("2026-12-13T23:00:00Z") / 1000) * 1000).toISOString()).toBe("2026-11-30T00:00:00.000Z");
  });

  test("the fixed week's text: counts only, within Telegram's limits", () => {
    const t = reportText({ weekStart: "2026-11-30", ...WEEK });
    expect(t).toBe(["Cofer weekly report: 2026-11-30 to 2026-12-06 (UTC)", "", "Groups: 12 (2 new this week)", "Active members: 41", "Votes run: 17", "Deposits: 23", "Exits: 3", "Allowance spends: 9", "", "Alerts open now: 1 (1 of them opened this week)", "Relayer: about 18.5 days of gas left", "Sponsored member actions: 64", "Indexer: live (2 s behind)"].join("\n"));
    expect(telegramProblem("sendMessage", { chat_id: -1, text: t })).toBeNull();
    expect(t).not.toMatch(/USDG|\$|value|price|total/i);
  });

  test("posted once, on Monday only", async () => {
    let last: string | null = null;
    const sent: string[] = [];
    const deps = (now: number) => ({ now: () => now, lastReported: async () => last, markReported: async (d: string) => void (last = d), counts: async () => WEEK, send: async (t: string) => void sent.push(t) });
    expect(await weeklyReport(deps(Date.parse("2026-12-06T09:00:00Z") / 1000))).toBeNull(); // Sunday
    expect(await weeklyReport(deps(MONDAY))).toContain("2026-11-30 to 2026-12-06");
    expect(await weeklyReport(deps(MONDAY + 3600))).toBeNull();
    expect(sent).toHaveLength(1);
  });
});
