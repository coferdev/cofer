import { describe, expect, test } from "bun:test";
import { adminQueueProjection, applyAdminOps, type AdminRow } from "../src/indexer/projections/adminQueue";
import type { EventIn } from "../src/indexer/projections/runner";

const F = "0x5d03d53A5630ceCC545Be46635779094A11E47D7";
const TSLA = "0x322F0929c4625eD5bAd873c95208D54E1c003b2d";
const ev = (block: bigint, name: string, args: Record<string, unknown>, address = F): EventIn => ({ block, logIndex: 0, txHash: `0x${block.toString(16).padStart(64, "0")}`, address, name, args });
const p = adminQueueProjection(F);

const EVENTS = [
  ev(100n, "FeedQueued", { asset: TSLA, feed: "0x00000000000000000000000000000000000000a1", maxStaleness: "345600", eta: "1800000000" }),
  ev(101n, "SwapFeeQueued", { bps: "40", eta: "1800000100" }),
  ev(102n, "FeedQueued", { asset: TSLA, feed: "0x00000000000000000000000000000000000000a2", maxStaleness: "345600", eta: "1800001000" }),
  ev(103n, "AdapterQueued", { adapter: "0x00000000000000000000000000000000000000b1", eta: "1800002000" }),
  ev(200n, "FeedApplied", { asset: TSLA, feed: "0x00000000000000000000000000000000000000a2", maxStaleness: "345600" }),
  ev(201n, "AdapterSet", { adapter: "0x00000000000000000000000000000000000000b1", allowed: true }),
  ev(202n, "AdapterSet", { adapter: "0x00000000000000000000000000000000000000b9", allowed: false }),
  ev(203n, "FeedQueued", { asset: TSLA, feed: "0x00000000000000000000000000000000000000a3", maxStaleness: "345600", eta: "1800009000" }, "0x00000000000000000000000000000000000000ff"),
];

describe("pending admin changes ledger", () => {
  test("queue, re-queue (the first is replaced), apply; another contract's look-alike log is ignored", () => {
    const rows = applyAdminOps([], p.reduce(EVENTS));
    expect(rows.map((r) => [r.kind, r.newValue, r.state, r.resolvedBlock])).toEqual([
      ["feed", "0x00000000000000000000000000000000000000a1", "replaced", 102n],
      ["swap fee", "40", "queued", null],
      ["feed", "0x00000000000000000000000000000000000000a2", "applied", 200n],
      ["adapter", "0x00000000000000000000000000000000000000b1", "applied", 201n],
    ]);
    expect(rows[1]!.eta).toBe(1_800_000_100);
    expect(rows[0]!.maxStaleness).toBe(345_600);
  });

  test("a backfill equals applying the events one at a time", () => {
    const once = applyAdminOps([], p.reduce(EVENTS));
    let step: AdminRow[] = [];
    for (const e of EVENTS) step = applyAdminOps(step, p.reduce([e]));
    expect(step).toEqual(once);
    expect(applyAdminOps(structuredClone(once), p.reduce(EVENTS.slice(0, 1)))).toEqual(once); // the same queue log twice is not added again
  });

  test("removing an adapter (AdapterSet false) is not an applied queued change", () => {
    expect(p.reduce([ev(1n, "AdapterSet", { adapter: "0x00000000000000000000000000000000000000b1", allowed: false })])).toEqual([]);
  });
});
