import { describe, expect, test } from "bun:test";
import recorded from "./fixtures/tx-receipts-46630.json";
import { feesProjection } from "../src/indexer/projections/fees";
import type { EventIn } from "../src/indexer/projections/runner";

const USDG = "0x14119629e364A53ceda500d0c1111DBB136A7398";
const POT = "0x50F19AdD1EE10AF538C1F8bE5bcbA4011F100115";
const ROUTER = recorded.feeRouter;
const ev = (block: bigint, logIndex: number, address: string, name: string, args: Record<string, string>): EventIn => ({ block, logIndex, txHash: `0x${block.toString(16).padStart(64, "0")}`, address, name, args });
const p = feesProjection(USDG);

describe("fee ledger", () => {
  test("a swap fee in the token swapped in, and a plan payment in USDG, each with its transaction", () => {
    const rows = p.reduce([
      ev(10n, 4, POT, "Swapped", { adapter: "0x522979FeE39C148FF181404BABb0dc78D427F3ec", tokenIn: USDG, tokenOut: "0x3232dDDE4c6a3FE39Fd17696791D50B54Bc52fFE", amountIn: "50000000", fee: "150000", amountOut: "1" }),
      ev(11n, 2, POT, "PlanPaid", { months: "3", cost: "27000000" }),
      ev(11n, 3, ROUTER, "PlanPaid", { pot: POT, months: "3", cost: "27000000", paidUntil: "1800000000" }),
    ]);
    expect(rows).toEqual([
      { id: `${ev(10n, 4, POT, "", {}).txHash}:4`, pot: POT, kind: "swap fee", asset: USDG, amount: 150_000n, months: null, block: 10n, tx: ev(10n, 0, POT, "", {}).txHash },
      { id: `${ev(11n, 2, POT, "", {}).txHash}:2`, pot: POT, kind: "plan", asset: USDG, amount: 27_000_000n, months: 3, block: 11n, tx: ev(11n, 0, POT, "", {}).txHash },
    ]);
  });

  test("the fee router's copy of a plan payment is not counted twice; a zero swap fee is not a fee", () => {
    expect(p.reduce([ev(1n, 0, ROUTER, "PlanPaid", { pot: POT, months: "1", cost: "9000000", paidUntil: "1" })])).toEqual([]);
    expect(p.reduce([ev(1n, 0, POT, "Swapped", { adapter: POT, tokenIn: USDG, tokenOut: USDG, amountIn: "1", fee: "0", amountOut: "1" })])).toEqual([]);
  });

  test("a backfill equals step by step (one row per log, ids unique)", () => {
    const evs = [ev(1n, 0, POT, "PlanPaid", { months: "1", cost: "9000000" }), ev(2n, 0, POT, "PlanPaid", { months: "2", cost: "18000000" })];
    expect([...p.reduce(evs.slice(0, 1)), ...p.reduce(evs.slice(1))]).toEqual(p.reduce(evs));
  });
});
