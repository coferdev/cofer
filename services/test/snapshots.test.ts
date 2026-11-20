import { describe, expect, test } from "bun:test";
import type { Address } from "viem";
import { blockAtOrAfter, midnightOf, takeSnapshots, type SnapshotDeps, type SnapshotRow } from "../src/keeper/snapshots";

const POT = "0x362B6794E6374b400aA186C1a67AC2c060af2E50" as Address;
const USDG = "0x14119629e364A53ceda500d0c1111DBB136A7398" as Address;
const DAY = "2026-12-01";
const T0 = midnightOf(DAY);

/** A chain with blocks every 2 seconds from T0 - 10000 s (with a 30 s gap), and an RPC that keeps only the newest 50 blocks unless it is an archive. */
function chain(archive: boolean) {
  const times: number[] = [];
  let t = T0 - 10_000;
  for (let i = 0; i < 20_000; i++) {
    times.push(t);
    t += i === 4_990 ? 30 : 2;
  }
  const head = BigInt(times.length - 1);
  const saved: SnapshotRow[] = [];
  const reads: bigint[] = [];
  const deps: SnapshotDeps = {
    head: async () => head,
    blockTime: async (n) => times[Number(n)]!,
    heldAt: async (_p, b) => {
      if (!archive && b < head - 50n) throw new Error("missing trie node");
      reads.push(b);
      return [USDG];
    },
    balanceAt: async (_t, _h, b) => 1_000_000n + b,
    pots: async () => [POT],
    has: async (p, d) => saved.some((r) => r.pot === p && r.day === d),
    save: async (rows) => void saved.push(...rows),
    now: () => T0 + 3600,
  };
  return { deps, saved, times, reads, head };
}

describe("daily holdings snapshots", () => {
  test("finds the first block at or after midnight", async () => {
    const c = chain(true);
    const b = await blockAtOrAfter(c.deps, T0);
    expect(c.times[Number(b)]).toBeGreaterThanOrEqual(T0);
    expect(c.times[Number(b) - 1]).toBeLessThan(T0);
  });

  test("an archive RPC: the snapshot is at midnight's block, balances only; once per day", async () => {
    const c = chain(true);
    expect(await takeSnapshots(c.deps, DAY)).toEqual({ day: DAY, pots: 1, skipped: 0 });
    const row = c.saved[0]!;
    expect(row.blockTime).toBeGreaterThanOrEqual(T0);
    expect(row.blockTime - T0).toBeLessThan(30);
    expect(Object.keys(row).sort()).toEqual(["asset", "block", "blockTime", "day", "pot", "rawBalance"]);
    expect(await takeSnapshots(c.deps, DAY)).toEqual({ day: DAY, pots: 0, skipped: 1 });
    expect(c.saved).toHaveLength(1);
  });

  test("an RPC without old state: the snapshot is taken at the newest block and says so", async () => {
    const c = chain(false);
    await takeSnapshots(c.deps, DAY);
    const row = c.saved[0]!;
    expect(row.block).toBe(c.head);
    expect(row.blockTime).toBe(c.times[Number(c.head)]!);
  });
});
