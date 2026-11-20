import { describe, expect, test } from "bun:test";
import { sponsorBudget, type SponsorBudgetDeps } from "../src/keeper/sponsorBudget";
import { parseEnv } from "../src/env";
import type { AlertDeps } from "../src/keeper/alerts";

const ETH = 10n ** 18n;
function world(budget: bigint | null) {
  let spent = 0n;
  let now = Date.parse("2026-12-10T12:00:00Z") / 1000;
  const open = new Map<string, string>();
  const sent: string[] = [];
  const alerts: AlertDeps = { open: async (k, t) => (open.has(k) ? false : (open.set(k, t), true)), close: async (k) => { const t = open.get(k) ?? null; open.delete(k); return t; }, send: async (t) => void sent.push(t) };
  const deps: SponsorBudgetDeps = { budgetWei: budget, spentThisMonth: async () => spent, openKeys: async () => [...open.keys()], now: () => now, alerts };
  return { deps, sent, open, set: (v: bigint) => (spent = v), nextMonth: () => (now = Date.parse("2027-01-02T00:00:00Z") / 1000) };
}

describe("sponsorship budget alarm", () => {
  test("posts once at 80% and once at 100% in a month", async () => {
    const w = world(ETH);
    w.set((ETH * 50n) / 100n);
    expect((await sponsorBudget(w.deps))!.spentBps).toBe(5000);
    expect(w.sent).toEqual([]);
    w.set((ETH * 81n) / 100n);
    await sponsorBudget(w.deps);
    await sponsorBudget(w.deps);
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]).toContain("sponsor-budget-80");
    expect(w.sent[0]).toContain("0.81 of 1 ETH");
    w.set(ETH);
    await sponsorBudget(w.deps);
    expect(w.sent).toHaveLength(2);
    expect(w.sent[1]).toContain("sponsor-budget-100");
  });

  test("a new month starts afresh: last month's alerts are dropped without a post", async () => {
    const w = world(ETH);
    w.set(ETH);
    await sponsorBudget(w.deps);
    w.nextMonth();
    w.set(0n);
    await sponsorBudget(w.deps);
    expect(w.open.size).toBe(0);
    expect(w.sent).toHaveLength(2);
  });

  test("without a budget setting the alarm is off; the setting reads ETH", async () => {
    expect(await sponsorBudget(world(null).deps)).toBeNull();
    const e = parseEnv({ PUBLIC_URL: "https://s.example", DATABASE_URL: "x", RHC_RPC_URL: "https://r.example", FACTORY_ADDRESS: "0x0000000000000000000000000000000000000001", ADAPTER_ADDRESS: "0x0000000000000000000000000000000000000002", RELAYER_PRIVATE_KEY: "0x01", TELEGRAM_BOT_TOKEN: "1:x", TELEGRAM_BOT_USERNAME: "x", TELEGRAM_WEBHOOK_SECRET: "w".repeat(24), LINK_SECRET: "l".repeat(32), SPONSOR_MONTHLY_BUDGET_ETH: "0.5" });
    expect(e.SPONSOR_MONTHLY_BUDGET_ETH).toBe(ETH / 2n);
  });
});
