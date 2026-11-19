import { describe, expect, test } from "bun:test";
import { LOCK_WINDOW_S, type TableView, decide, jobId, planTable } from "../src/arena/jobs/plan";

const T = "0x00000000000000000000000000000000000000AA";
const base: TableView = { table: T, state: "Open", lockAt: 1_000, openUntil: 0, seats: 3, minSeats: 3, endAt: 0, disputeEnd: 0, hardDeadline: 0, round: 0 };
const t = (x: Partial<TableView>) => ({ ...base, ...x });

describe("arena jobs", () => {
  test("each state schedules its jobs, with fixed IDs", () => {
    expect(planTable(base)).toEqual([{ name: "lock", jobId: `lock:${T.toLowerCase()}:1000`, at: 1_000 }]);
    expect(planTable(t({ lockAt: 0, openUntil: 5_000 }))[0]!.at).toBe(5_000);
    expect(planTable(t({ state: "Locked", endAt: 90_000, hardDeadline: 176_400 })).map((j) => j.name)).toEqual(["close", "deadline"]);
    expect(planTable(t({ state: "Settling", disputeEnd: 97_200, hardDeadline: 176_400 })).map((j) => j.name)).toEqual(["finalize", "deadline"]);
    expect(planTable(t({ state: "Disputed", hardDeadline: 176_400 })).map((j) => j.name)).toEqual(["deadline"]);
    expect(planTable(t({ state: "Settled", disputeEnd: 100 })).map((j) => j.at)).toEqual([3_700, 86_500, 604_900]);
    expect(planTable(t({ state: "Refunded" }))).toEqual([]);
    expect(jobId("lock", T, 1)).toBe(jobId("lock", T.toLowerCase(), 1));
  });

  test("lock and cancel follow the escrow: enough seats inside the window lock, else cancel", () => {
    expect(decide("lock", base, 999)).toEqual({ call: null, why: "too early" });
    expect(decide("lock", base, 1_000)).toEqual({ call: "lock" });
    expect(decide("lock", t({ seats: 2 }), 1_000)).toEqual({ call: "cancel" });
    expect(decide("lock", base, 1_000 + LOCK_WINDOW_S)).toEqual({ call: "cancel" });
    expect(decide("lock", t({ state: "Locked" }), 1_000).call).toBe(null);
    expect(decide("lock", t({ lockAt: 0, openUntil: 5_000 }), 4_999).call).toBe(null);
    expect(decide("lock", t({ lockAt: 0, openUntil: 5_000 }), 5_000)).toEqual({ call: "cancel" });
  });

  test("a posted result is finalized, never refunded; refunds only from Locked or Disputed after the deadline", () => {
    const settling = t({ state: "Settling", disputeEnd: 100, hardDeadline: 200 });
    expect(decide("finalize", settling, 99).call).toBe(null);
    expect(decide("finalize", settling, 100)).toEqual({ call: "finalize" });
    expect(decide("deadline", settling, 500).call).toBe(null);
    expect(decide("deadline", t({ state: "Locked", hardDeadline: 200 }), 199).call).toBe(null);
    expect(decide("deadline", t({ state: "Locked", hardDeadline: 200 }), 200)).toEqual({ call: "refundAll" });
    expect(decide("deadline", t({ state: "Disputed", hardDeadline: 200 }), 200)).toEqual({ call: "refundAll" });
    expect(decide("deadline", t({ state: "Settled" }), 10_000).call).toBe(null);
    expect(decide("close", t({ state: "Locked", endAt: 50 }), 50)).toEqual({ call: "close-game" });
    expect(decide("claim-nudge", t({ state: "Settled" }), 0)).toEqual({ call: "nudge" });
  });
});
