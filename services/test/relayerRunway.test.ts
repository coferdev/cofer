import { describe, expect, test } from "bun:test";
import { daysLeft, runwayProblem } from "../src/core/relayerRunway";
import { checkRelayerRunway } from "../src/keeper/keeper";
import type { AlertDeps } from "../src/keeper/alerts";

const ETH = 10n ** 18n;

describe("relayer days-left forecast", () => {
  test("steady spend: balance over the 14-day average", () => {
    expect(daysLeft(ETH, Array(14).fill(ETH / 100n))).toBe(100);
  });

  test("rising spend lowers the forecast; missing days count as zero", () => {
    expect(daysLeft(ETH, Array.from({ length: 14 }, (_, i) => (BigInt(i + 1) * ETH) / 1000n))).toBe(133.3);
    expect(daysLeft(ETH, [ETH / 10n])).toBe(140);
  });

  test("no spend: nothing to forecast", () => {
    expect(daysLeft(ETH, [])).toBeNull();
    expect(daysLeft(ETH, [0n, 0n])).toBeNull();
    expect(runwayProblem(null)).toBeNull();
  });

  test("staff are warned under 7 days, and it clears above", async () => {
    let days: number | null = 5.5;
    const open = new Map<string, string>();
    const sent: string[] = [];
    const alerts: AlertDeps = { open: async (k, t) => (open.has(k) ? false : (open.set(k, t), true)), close: async (k) => { const t = open.get(k) ?? null; open.delete(k); return t; }, send: async (t) => void sent.push(t) };
    await checkRelayerRunway({ daysLeft: async () => days, alerts });
    expect(sent[0]).toContain("relayer-days-left");
    expect(sent[0]).toContain("about 5.5 days of gas left");
    days = 9;
    await checkRelayerRunway({ daysLeft: async () => days, alerts });
    expect(open.size).toBe(0);
  });
});
