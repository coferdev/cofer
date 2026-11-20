import { describe, expect, test } from "bun:test";
import type { Hex } from "viem";
import recorded from "./fixtures/tx-receipts-46630.json";
import { syncSponsored, userOpRows, type RawLog, type SponsoredDeps, type UserOpRow } from "../src/keeper/sponsored";

const EP = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const MEMBER_A = "0xD6D8195a52Fa752A5bBaf76b598336FecAc9c585";
const MEMBER_B = "0x8251FA75f4982cDCB4bE015B9F7Ba20116a1596C";
/** The recorded testnet receipts' EntryPoint logs. */
const LOGS: RawLog[] = recorded.receipts.flatMap((r) => r.logs.filter((l) => l.address.toLowerCase() === EP.toLowerCase()).map((l) => ({ address: l.address, topics: l.topics as Hex[], data: l.data as Hex, blockNumber: BigInt(r.blockNumber), transactionHash: r.transactionHash })));

describe("sponsored actions ledger", () => {
  test("recorded testnet member actions: sender, paymaster (none here), gas used, cost, result, day", () => {
    const rows = userOpRows(LOGS, EP, new Set([MEMBER_A.toLowerCase(), MEMBER_B.toLowerCase()]), () => "2026-11-07");
    expect(rows.map((r) => [r.sender, r.sponsored, r.success, r.gasUsed])).toEqual([
      [MEMBER_A, false, true, 702856n],
      [MEMBER_A, false, true, 597271n],
      [MEMBER_B, false, true, 604104n],
    ]);
    expect(rows[0]!.userOpHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test("only known member accounts are kept", () => {
    expect(userOpRows(LOGS, EP, new Set([MEMBER_B.toLowerCase()]), () => "d").map((r) => r.sender)).toEqual([MEMBER_B]);
    expect(userOpRows(LOGS, EP, new Set(), () => "d")).toEqual([]);
  });

  test("the job moves forward in block ranges and never reads a range twice", async () => {
    const saved: UserOpRow[] = [];
    let cur: bigint | null = null;
    const asked: [bigint, bigint][] = [];
    const deps: SponsoredDeps = {
      entryPoint: EP,
      members: async () => [MEMBER_A],
      head: async () => 45_000n,
      startBlock: 1n,
      cursor: async () => cur,
      logs: async (f, t) => (asked.push([f, t]), f === 1n ? LOGS : []),
      blockTime: async () => 1_790_000_000,
      save: async (rows, last) => void (saved.push(...rows), (cur = last)),
    };
    expect(await syncSponsored(deps)).toEqual({ from: 1n, to: 45_000n, rows: 2 });
    expect(asked).toEqual([[1n, 20_000n], [20_001n, 40_000n], [40_001n, 45_000n]]);
    expect(await syncSponsored(deps)).toBeNull();
    expect(saved).toHaveLength(2); // member A's two actions; member B is not in this run's list
  });
});
