import { describe, expect, test } from "bun:test";
import { position, runEnrichedProjection, type EventIn, type LedgerStore } from "../src/indexer/projections/runner";
import { RELAYER_SPEND, relayerSpendRows, spendByDay, type SpendReader, type SpendRow } from "../src/indexer/projections/relayerSpend";

const RELAYER = "0x00000000000000000000000000000000000000Re".replace("Re", "e1");
const MEMBER = "0x00000000000000000000000000000000000000a1";
const T0 = Date.parse("2026-12-01T00:00:00Z") / 1000;
const ev = (block: bigint, tx: string, name = "ProposalExecuted"): EventIn => ({ block, logIndex: 0, txHash: tx, address: "0x362B6794E6374b400aA186C1a67AC2c060af2E50", name, args: {} });
const reader = (fail = new Set<string>()): SpendReader => ({
  receipt: async (tx) => {
    if (fail.has(tx)) throw new Error("rpc");
    return { from: tx.endsWith("m") ? MEMBER : RELAYER, gasUsed: 100_000n, effectiveGasPrice: 2_000_000_000n, blockNumber: BigInt(parseInt(tx.slice(2, 6), 16)) };
  },
  blockTime: async (n) => T0 + Number(n) * 3600,
});

describe("relayer spend ledger", () => {
  test("one row per transaction the relayer sent, with its gas cost and UTC day; members' own runs are left out", async () => {
    const rows = await relayerSpendRows([ev(1n, "0x0001r"), ev(1n, "0x0001r"), ev(2n, "0x0002m"), ev(30n, "0x001er")], RELAYER as `0x${string}`, reader());
    expect(rows.map((r) => [r.tx, r.day, r.costWei])).toEqual([
      ["0x0001r", "2026-12-01", 200_000_000_000_000n],
      ["0x001er", "2026-12-02", 200_000_000_000_000n],
    ]);
    expect(spendByDay(rows)).toEqual(new Map([["2026-12-01", 200_000_000_000_000n], ["2026-12-02", 200_000_000_000_000n]]));
  });

  test("a failed read writes nothing and the same events are tried again; a backfill equals step by step", async () => {
    const events = [ev(1n, "0x0001r"), ev(2n, "0x0002r"), ev(3n, "0x0003r")];
    const mem = () => {
      const rows: SpendRow[] = [];
      let cur: bigint | null = null;
      const store: LedgerStore<SpendRow> = { cursor: async () => cur, events: async (after, _n, limit) => events.filter((e) => after === null || position(e.block, e.logIndex) > after).slice(0, limit), commit: async (_n, to, ch) => void (rows.push(...ch), (cur = to)) };
      return { store, rows, cur: () => cur };
    };
    const failing = new Set(["0x0002r"]);
    const m = mem();
    await expect(runEnrichedProjection(RELAYER_SPEND, ["ProposalExecuted"], (evs) => relayerSpendRows(evs, RELAYER as `0x${string}`, reader(failing)), m.store, 1)).rejects.toThrow("rpc");
    expect(m.rows.map((r) => r.tx)).toEqual(["0x0001r"]);
    expect(m.cur()).toBe(position(1n, 0));
    failing.clear();
    await runEnrichedProjection(RELAYER_SPEND, ["ProposalExecuted"], (evs) => relayerSpendRows(evs, RELAYER as `0x${string}`, reader(failing)), m.store, 1);
    const once = mem();
    await runEnrichedProjection(RELAYER_SPEND, ["ProposalExecuted"], (evs) => relayerSpendRows(evs, RELAYER as `0x${string}`, reader()), once.store);
    expect(m.rows).toEqual(once.rows);
  });
});
