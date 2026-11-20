import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Address, type Hex, getAddress, keccak256, toHex } from "viem";
import type { TableView } from "../src/arena/jobs/plan";
import { type RelayCall, type SweepDeps, sweepOnce } from "../src/arena/jobs/sweep";
import { makeRelayer } from "../src/arena/jobs/relay";
import { readTable } from "../src/arena/chain/tableView";
import { ARENA_ABI } from "../src/arena/chain/contracts";
import { issue } from "../src/arena/eligibility/signer";
import { ROLE, USDG_ABI, acct, available, createTable, friendParams, startLocalChain, type LocalChain } from "./arenaLocalChain";

const T = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const view = (o: Partial<TableView>): TableView => ({ table: T(1), state: "Open", lockAt: 1_000, openUntil: 0, seats: 0, minSeats: 2, endAt: 0, disputeEnd: 0, hardDeadline: 0, round: 0, ...o });

function fakes(views: TableView[], now: number) {
  const calls: string[] = [];
  const d: SweepDeps = {
    liveTables: async () => views.map((v) => v.table as Address),
    view: async (t) => {
      const v = views.find((x) => x.table === t)!;
      if (v.state === ("Broken" as never)) throw new Error("rpc down");
      return v;
    },
    chainNow: async () => now,
    relay: async (t, c) => (calls.push(`${t.slice(-2).toLowerCase()}:${c}`), { sent: true, tx: "0xabc" }),
    log: () => {},
  };
  return { d, calls };
}

describe("table jobs: what is due", () => {
  test("lock when enough seats; cancel when too few or the lock window passed; nothing early", async () => {
    const f = fakes([view({ table: T(1), seats: 2 }), view({ table: T(2), seats: 1 }), view({ table: T(3), seats: 3, lockAt: 5_000 })], 1_000);
    await sweepOnce(f.d);
    expect(f.calls).toEqual(["01:lock", "02:cancel"]);
    const g = fakes([view({ table: T(4), seats: 3 })], 1_000 + 3_600);
    await sweepOnce(g.d);
    expect(g.calls).toEqual(["04:cancel"]);
  });

  test("a sit-and-go cancels only after its window; a locked game closes (no engine yet) and refunds after the deadline", async () => {
    const f = fakes([
      view({ table: T(5), lockAt: 0, openUntil: 2_000, seats: 1 }),
      view({ table: T(6), state: "Locked", endAt: 900, hardDeadline: 5_000 }),
      view({ table: T(7), state: "Locked", endAt: 900, hardDeadline: 1_000 }),
    ], 1_000);
    const items = await sweepOnce(f.d);
    expect(f.calls).toEqual(["07:refundAll"]);
    expect(items.filter((i) => i.outcome === "no-engine").map((i) => i.table)).toEqual([T(6), T(7)]);
  });

  test("finalize after the dispute window; a posted result is never refunded; a disputed one refunds at the deadline", async () => {
    const f = fakes([
      view({ table: T(8), state: "Settling", disputeEnd: 1_000, hardDeadline: 900 }),
      view({ table: T(9), state: "Settling", disputeEnd: 2_000, hardDeadline: 900 }),
      view({ table: T(10), state: "Disputed", hardDeadline: 1_000 }),
    ], 1_000);
    await sweepOnce(f.d);
    expect(f.calls).toEqual(["08:finalize", "0a:refundAll"]);
  });

  test("a table it cannot read is skipped and the others still run", async () => {
    const f = fakes([view({ table: T(11), state: "Broken" as never }), view({ table: T(12), seats: 2 })], 1_000);
    await sweepOnce(f.d);
    expect(f.calls).toEqual(["0c:lock"]);
  });
});

describe.skipIf(!available())("table jobs on a local chain (real contracts, real relayer)", () => {
  let lc: LocalChain;
  beforeAll(async () => {
    lc = await startLocalChain();
  }, 120_000);
  afterAll(() => lc?.stop());

  const usdg = () => ({ address: lc.contracts.usdg, abi: USDG_ABI() as never });
  async function join(table: Address, i: number) {
    const w = lc.wallet(i);
    const buy = 10_000_000n;
    await lc.pub.waitForTransactionReceipt({ hash: await w.writeContract({ ...usdg(), functionName: "mint", args: [w.account.address, buy] } as never) });
    await lc.pub.waitForTransactionReceipt({ hash: await w.writeContract({ ...usdg(), functionName: "approve", args: [table, buy] } as never) });
    const now = (await lc.now()) * 1000;
    const r = await issue(
      { chainId: 46630, table, mode: "FRIEND", hasStocks: false, player: w.account.address, telegramId: `tg${i}`, credentialId: `cred${i}`, declared: "DE", ipCountry: "DE", asnClass: null, accountCreatedAt: now - 7 * 86_400_000, practiceGamesFinished: 1, seated: [], now },
      async (digest) => acct(ROLE.elig).sign({ hash: digest }),
    );
    if (!r.ok) throw new Error(`eligibility refused: ${r.refusal}`);
    const skh = keccak256(toHex(`session-${i}`));
    await lc.pub.waitForTransactionReceipt({ hash: await w.writeContract({ address: table, abi: ARENA_ABI.escrow, functionName: "join", args: [skh, "0x", r.eligibility] }) });
  }
  const state = async (t: Address) => (await readTable(lc.pub, t)).state;
  const sweep = (tables: Address[]) => {
    const relay = makeRelayer(lc.pub, lc.wallet(ROLE.relayer));
    return sweepOnce({ liveTables: async () => tables, view: (t) => readTable(lc.pub, t), chainNow: lc.now, relay: relay as (t: Address, c: RelayCall) => ReturnType<typeof relay>, log: () => {} });
  };

  test("lock at the start time, cancel a table with too few players, refund a locked game at its deadline", async () => {
    const start = (await lc.now()) + 600;
    const full = await createTable(lc, 9, friendParams(lc.contracts, { lockAt: start }), 1);
    const short = await createTable(lc, 9, friendParams(lc.contracts, { lockAt: start }), 2);
    await join(full, 9);
    await join(full, 10);
    await join(short, 11);
    expect(await readTable(lc.pub, full)).toMatchObject({ state: "Open", seats: 2, minSeats: 2, lockAt: start });

    // before the start: nothing is due, nothing is sent
    expect((await sweep([full, short])).filter((i) => i.outcome && typeof i.outcome === "object")).toEqual([]);

    await lc.warp(601);
    const s1 = await sweep([full, short]);
    expect(s1.map((i) => [i.table, i.action.call, (i.outcome as { sent: boolean }).sent])).toEqual([[full, "lock", true], [short, "cancel", true]]);
    expect(await state(full)).toBe("Locked");
    expect(await state(short)).toBe("Refunded");

    // the short table's player can take their buy-in back
    const w11 = lc.wallet(11);
    await lc.pub.waitForTransactionReceipt({ hash: await w11.writeContract({ address: short, abi: ARENA_ABI.escrow, functionName: "claim", args: [w11.account.address] }) });

    // the game ends with no engine: no call; after the hard deadline everyone is refunded, by anyone
    const v = await readTable(lc.pub, full);
    await lc.warp(v.endAt - (await lc.now()) + 1);
    const s2 = await sweep([full]);
    expect(s2.map((i) => i.outcome)).toEqual(["no-engine"]);
    await lc.warp(v.hardDeadline - (await lc.now()) + 1);
    const s3 = await sweep([full]);
    expect(s3.find((i) => i.action.call === "refundAll")?.outcome).toMatchObject({ sent: true });
    expect(await state(full)).toBe("Refunded");

    // a call the escrow would refuse is never sent
    const relay = makeRelayer(lc.pub, lc.wallet(ROLE.relayer));
    expect(await relay(full, "lock")).toMatchObject({ sent: false, why: expect.stringContaining("would refuse") });
  }, 120_000);
});
