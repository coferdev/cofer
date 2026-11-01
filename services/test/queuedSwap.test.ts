import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { QUEUED_SLIP_SUGGESTION_BPS, queuedSwapNote } from "../src/core/swap";

describe("bot note for swaps that wait the exit window (audit H-2)", () => {
  test("default group (6h window, 3% limit), default 1% slip: explains the wait and suggests slip=2", () => {
    expect(queuedSwapNote({ side: "buy", guardDelaySec: 6 * 3600, slipBps: 100, maxSlipBps: 300 })).toBe(
      "Unless every member signs, this buy waits the group's exit window (6 hours) before it runs, so anyone who disagrees can /exit first. " +
        "If the price moves more than 1% (your slip) in that time, it fails and needs a new vote. " +
        "For more room, propose again with slip=2 (this group allows up to 3%).",
    );
  });

  test("sells say sell; a 1-hour window reads as one hour", () => {
    const n = queuedSwapNote({ side: "sell", guardDelaySec: 3600, slipBps: 100, maxSlipBps: 300 })!;
    expect(n).toContain("this sell waits the group's exit window (1 hour)");
  });

  test("no suggestion when the slip already gives that room, or the group's limit is lower", () => {
    expect(queuedSwapNote({ side: "buy", guardDelaySec: 21600, slipBps: 200, maxSlipBps: 300 })).not.toContain("slip=");
    expect(queuedSwapNote({ side: "buy", guardDelaySec: 21600, slipBps: 250, maxSlipBps: 300 })).not.toContain("slip=");
    // a group limit of 1.5%: the suggestion is capped at the limit
    expect(queuedSwapNote({ side: "buy", guardDelaySec: 21600, slipBps: 50, maxSlipBps: 150 })).toContain("slip=1.5 (this group allows up to 1.5%)");
    expect(queuedSwapNote({ side: "buy", guardDelaySec: 21600, slipBps: 150, maxSlipBps: 150 })).not.toContain("slip=");
    expect(QUEUED_SLIP_SUGGESTION_BPS).toBe(200);
  });

  test("a group with no exit window gets no note (its swaps run as soon as they pass)", () => {
    expect(queuedSwapNote({ side: "buy", guardDelaySec: 0, slipBps: 100, maxSlipBps: 300 })).toBeNull();
  });

  test("/buy and /sell send the note with the proposal", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "bot", "bot.ts"), "utf8");
    expect(src).toContain("return { action, note: queuedSwapNote({ side, guardDelaySec: Number(cfg[0]), slipBps, maxSlipBps: Number(cfg[1]) }) };");
    expect(src.match(/await propose\(ctx, s\.action, s\.note\);/g)).toHaveLength(2);
  });
});
