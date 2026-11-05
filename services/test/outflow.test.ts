import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  OUTFLOW_ALERT,
  OUTFLOW_ALERT_USDG,
  OUTFLOW_EVENTS,
  OUTFLOW_WHO,
  OUTFLOW_WINDOW_SEC,
  outflowAlert,
  outflowsOf,
  summarize,
  valueFromHolding,
  type Outflow,
  type PotEvent,
} from "../src/core/outflow";
import { checkLargeOutflow, type OutflowDeps } from "../src/keeper/keeper";
import type { AlertDeps } from "../src/keeper/alerts";

const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const TSLA = "0x322F0929c4625eD5bAd873c95208D54E1c003b2d";
const POT_A = "0x2D3365a056074f6cd35C943EDcE644FAE7Eb8A45";
const POT_B = "0x0d6e43d4d7944408d9a5A10BC57B4348d61cD764";
const MEMBER = "0x00000000000000000000000000000000000B0b00";
const U = 1_000_000n; // 1 USDG
const T = 10n ** 18n; // 1 TSLA
const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const ev = (name: string, args: Record<string, unknown>, txn = 1, pot = POT_A): PotEvent => ({ pot, name, args, txHash: tx(txn) });

describe("large outflow: the settings", () => {
  test("more than 5,000 USDG within one hour; the dev checks it is real activity", () => {
    expect(OUTFLOW_ALERT_USDG).toBe(5_000n * U);
    expect(OUTFLOW_WINDOW_SEC).toBe(3600);
    expect(OUTFLOW_ALERT).toBe("large-outflow");
    expect(OUTFLOW_WHO).toBe("Dev checks it is real activity.");
  });
});

describe("large outflow: what counts as leaving a pot", () => {
  test("exits (each asset), voted transfers, allowance spends, plan payments and claimed set-aside tokens", () => {
    const out = outflowsOf(
      [
        ev("Exited", { member: MEMBER, to: MEMBER, shares: "1", assets: [USDG, TSLA], amounts: ["100000000", "2000000000000000000"] }, 1),
        ev("Transferred", { asset: USDG, to: MEMBER, amount: "50000000" }, 2),
        ev("AllowanceSpent", { member: MEMBER, to: MEMBER, amount: "7000000", memo: "0x00", remaining: "0" }, 3),
        ev("PlanPaid", { months: 3, cost: "27000000" }, 4),
        ev("OwedClaimed", { asset: TSLA, account: MEMBER, amount: "1000000000000000000" }, 5),
      ],
      USDG,
    );
    expect(out.map((o) => [o.asset, o.amount, o.txHash])).toEqual([
      [USDG, 100n * U, tx(1)],
      [TSLA, 2n * T, tx(1)],
      [USDG, 50n * U, tx(2)],
      [USDG, 7n * U, tx(3)],
      [USDG, 27n * U, tx(4)],
      [TSLA, 1n * T, tx(5)],
    ]);
  });

  test("a token set aside during an exit is not counted then (it has not left), only when it is claimed", () => {
    const exit = [
      ev("Exited", { member: MEMBER, to: MEMBER, shares: "1", assets: [USDG, TSLA], amounts: ["100000000", "2000000000000000000"] }, 1),
      ev("ExitOwed", { asset: TSLA, account: MEMBER, amount: "2000000000000000000" }, 1), // TSLA paused: all of it set aside
    ];
    expect(outflowsOf(exit, USDG).map((o) => [o.asset, o.amount])).toEqual([[USDG, 100n * U]]);
    const later = [...exit, ev("OwedClaimed", { asset: TSLA, account: MEMBER, amount: "2000000000000000000" }, 9)];
    expect(outflowsOf(later, USDG).map((o) => [o.asset, o.amount])).toEqual([
      [USDG, 100n * U],
      [TSLA, 2n * T],
    ]);
  });

  test("a set-aside in a different transaction does not reduce this exit", () => {
    const out = outflowsOf(
      [
        ev("Exited", { member: MEMBER, to: MEMBER, shares: "1", assets: [TSLA], amounts: ["2000000000000000000"] }, 1),
        ev("ExitOwed", { asset: TSLA, account: MEMBER, amount: "2000000000000000000" }, 2),
      ],
      USDG,
    );
    expect(out.map((o) => o.amount)).toEqual([2n * T]);
  });

  test("swaps, deposits and zero amounts are not outflows", () => {
    const out = outflowsOf(
      [
        ev("Swapped", { adapter: MEMBER, tokenIn: USDG, tokenOut: TSLA, amountIn: "100000000", fee: "300000", amountOut: "1" }),
        ev("Deposited", { member: MEMBER, amount: "100000000", shares: "1", nav: "1" }),
        ev("Transferred", { asset: USDG, to: MEMBER, amount: "0" }),
        ev("Exited", { member: MEMBER, to: MEMBER, shares: "1", assets: [USDG], amounts: ["0"] }),
      ],
      USDG,
    );
    expect(out).toEqual([]);
  });

  test("the keeper reads exactly these event kinds", () => {
    expect([...OUTFLOW_EVENTS].sort()).toEqual(["AllowanceSpent", "ExitOwed", "Exited", "OwedClaimed", "PlanPaid", "Transferred"]);
  });
});

describe("large outflow: pricing", () => {
  const out = (asset: string, amount: bigint, pot = POT_A, n = 1): Outflow => ({ pot, asset, amount, txHash: tx(n) });
  const price = async (o: Outflow) => (o.asset === USDG ? o.amount : o.asset === TSLA ? (o.amount * 250n * U) / T : null);

  test("adds up USDG value across pots, finds the largest pot and the largest single outflow", async () => {
    const s = await summarize([out(USDG, 1_000n * U, POT_A, 1), out(TSLA, 10n * T, POT_B, 2), out(USDG, 3_000n * U, POT_B, 3)], price);
    expect(s).toEqual({ totalUsdg: 6_500n * U, pots: 2, topPot: POT_B.toLowerCase(), topPotUsdg: 5_500n * U, topTx: tx(3), unpriced: 0 });
  });

  test("an outflow that cannot be priced is counted apart, not as zero and not as a guess", async () => {
    const s = await summarize([out(USDG, 100n * U), out("0x00000000000000000000000000000000000000AA", 5n * T)], price);
    expect([s.totalUsdg, s.unpriced]).toEqual([100n * U, 1]);
  });

  test("fallback when the oracle refuses: the value last recorded for that holding, pro rata", () => {
    expect(valueFromHolding(2n * T, { rawBalance: (10n * T).toString(), valueUsdg: (2_500n * U).toString() })).toBe(500n * U);
    expect(valueFromHolding(2n * T, { rawBalance: "0", valueUsdg: "1" })).toBeNull();
    expect(valueFromHolding(2n * T, { rawBalance: "1", valueUsdg: null })).toBeNull(); // feed was stale when recorded
    expect(valueFromHolding(2n * T, undefined)).toBeNull();
  });
});

describe("large outflow: the alert", () => {
  const name = (p: string) => (p === POT_A.toLowerCase() ? "Trip fund" : "Book club");
  const summary = (totalUsdg: bigint, extra: Partial<Parameters<typeof outflowAlert>[0]> = {}) => ({
    totalUsdg,
    pots: 1,
    topPot: POT_A.toLowerCase(),
    topPotUsdg: totalUsdg,
    topTx: tx(7),
    unpriced: 0,
    ...extra,
  });

  test("exactly 5,000 USDG: no alert; one base unit more: alert", () => {
    expect(outflowAlert(summary(5_000n * U), name)).toBeNull();
    expect(outflowAlert(summary(5_000n * U + 1n), name)?.name).toBe("large-outflow");
  });

  test("one pot: total and its name, who acts, and the largest transaction", () => {
    expect(outflowAlert(summary(6_000n * U), name)).toEqual({
      name: "large-outflow",
      what: "6,000 USDG worth left 1 group account in the last hour (Trip fund). Exits are never paused; this alert only reports it.",
      who: "Dev checks it is real activity.",
      tx: tx(7),
    });
  });

  test("several pots: names the largest; unpriced outflows are mentioned", () => {
    const a = outflowAlert(summary(8_250n * U, { pots: 3, topPotUsdg: 6_000n * U, unpriced: 2 }), name)!;
    expect(a.what).toBe(
      "8,250 USDG worth left 3 group accounts in the last hour; largest: Trip fund, 6,000 USDG. 2 more could not be priced right now and are not in that total. Exits are never paused; this alert only reports it.",
    );
  });
});

describe("large outflow: the keeper check", () => {
  function deps(events: PotEvent[], now = 1_800_000_000) {
    const sent: string[] = [];
    const open = new Map<string, string>();
    let since = 0;
    const alerts: AlertDeps = {
      async open(k, t) {
        if (open.has(k)) return false;
        open.set(k, t);
        return true;
      },
      async close(k) {
        const t = open.get(k) ?? null;
        open.delete(k);
        return t;
      },
      async send(t) {
        sent.push(t);
      },
    };
    const d: OutflowDeps = {
      events: async (s) => ((since = s), events),
      price: async (o) => (o.asset === USDG ? o.amount : null),
      potName: () => "Trip fund",
      usdg: USDG,
      alerts,
      now: () => now,
    };
    return { d, sent, open, since: () => since };
  }

  test("reads the last hour, opens one alert above the limit, says nothing more while it holds, clears when it falls back", async () => {
    const big = [ev("Exited", { member: MEMBER, to: MEMBER, shares: "1", assets: [USDG], amounts: ["6000000000"] }, 7)];
    const a = deps(big);
    expect(await checkLargeOutflow(a.d)).toBe((6_000n * U).toString());
    expect(a.since()).toBe(1_800_000_000 - 3600);
    expect(a.sent).toHaveLength(1);
    expect(a.sent[0]).toStartWith("[cofer alert] large-outflow\n6,000 USDG worth left 1 group account in the last hour (Trip fund).");
    expect(a.sent[0]).toContain("\nWho acts: Dev checks it is real activity.");

    await checkLargeOutflow({ ...a.d }); // still above: no second post
    expect(a.sent).toHaveLength(1);

    const quiet = deps([]);
    await checkLargeOutflow({ ...quiet.d, alerts: a.d.alerts }); // the hour moved on
    expect(a.sent[1]).toStartWith("[cofer alert] large-outflow: Cleared");
    expect(a.open.size).toBe(0);
  });

  test("below the limit: nothing is posted", async () => {
    const a = deps([ev("Transferred", { asset: USDG, to: MEMBER, amount: "4999000000" })]);
    await checkLargeOutflow(a.d);
    expect(a.sent).toEqual([]);
  });

  test("runs with the other ops checks every 5 minutes", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "keeper", "keeper.ts"), "utf8");
    expect(src).toContain("largeOutflowUsdg: () => checkLargeOutflow(),");
    expect(src).toContain('await q.upsertJobScheduler("ops", { every: 300_000 }, { name: "ops" });');
  });
});
