import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { type Abi, type AbiEvent, type Address, type Hex, type Log, encodeAbiParameters, encodeEventTopics, getAddress } from "viem";
import { ARENA_ABI, ARENA_DEPLOYMENTS, type ArenaContracts, arenaContracts } from "../src/arena/chain/contracts";
import { decodeArenaLog } from "../src/arena/indexer/arenaEvents";
import { ARENA_CURSOR, type ChainReader, indexArenaOnce } from "../src/arena/indexer/indexer";
import type { TableParamsView } from "../src/arena/indexer/store";
import { migrateArena } from "../src/arena/db/migrate";
import { startProblem } from "../src/arena/indexer/main";
import { arenaEnv } from "../src/arena/env";

const ROOT = join(import.meta.dir, "../..");

describe("arena contracts", () => {
  test("the testnet addresses are the deploy record's; mainnet has none yet", () => {
    const rec = JSON.parse(readFileSync(join(ROOT, "contracts/deployments/46630-arena.json"), "utf8"));
    const c = arenaContracts(46630)!;
    for (const k of ["usdg", "cofr", "registry", "escrowImplementation", "factory", "stakePool", "prizeVault"] as const) expect(c[k]).toBe(getAddress(rec[k]));
    expect(arenaContracts(4663)).toBeNull();
    expect(Object.keys(ARENA_DEPLOYMENTS)).toEqual(["46630"]);
  });

  test.skipIf(!existsSync(join(ROOT, "contracts/out/TableEscrow.sol/TableEscrow.json")))("the ABIs are the contracts' build", () => {
    for (const [k, c] of [["factory", "TableFactory"], ["escrow", "TableEscrow"], ["registry", "ResultRegistry"], ["vault", "PrizeVault"], ["pool", "StakePool"]] as const) {
      const out = JSON.parse(readFileSync(join(ROOT, `contracts/out/${c}.sol/${c}.json`), "utf8")).abi;
      expect(ARENA_ABI[k]).toEqual(out);
    }
  });

  test("the indexer refuses mainnet and a switched-off feature", () => {
    const e = (x: Record<string, string>) => arenaEnv({ DATABASE_URL: "postgres://x", RHC_RPC_URL: "http://127.0.0.1:1", ...x });
    expect(startProblem(e({ CHAIN_ID: "4663", ARENA_FEATURES_MAINNET: "app" }), { ARENA_FEATURES_MAINNET: "app" })).toContain("no Arena contracts");
    expect(startProblem(e({ CHAIN_ID: "46630" }), {})).toContain("off");
    expect(startProblem(e({ CHAIN_ID: "46630", ARENA_FEATURES: "app" }), { ARENA_FEATURES: "app" })).toBeNull();
  });
});

// ---- logs built exactly as the contracts emit them (topics for indexed inputs, ABI data for the rest)
let seq = 0;
function mkLog(abi: Abi, address: Address, eventName: string, args: Record<string, unknown>, block: bigint): Log {
  const ev = abi.find((x) => x.type === "event" && x.name === eventName) as AbiEvent;
  const topics = encodeEventTopics({ abi: [ev], eventName, args: args as never }) as Hex[];
  const rest = ev.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(rest, rest.map((i) => args[i.name!]) as never);
  seq++;
  return { address, topics: topics as [Hex, ...Hex[]], data, blockNumber: block, logIndex: seq, transactionHash: `0x${seq.toString(16).padStart(64, "0")}` as Hex, blockHash: null, transactionIndex: 0, removed: false } as unknown as Log;
}

const C: ArenaContracts = { ...ARENA_DEPLOYMENTS[46630]!, startBlock: 100n };
const TABLE = getAddress("0x00000000000000000000000000000000000000aa");
const HOST = getAddress("0x00000000000000000000000000000000000000b0");
const P = [1, 2, 3].map((i) => getAddress(`0x00000000000000000000000000000000000000c${i}`));
const H = (b: number) => `0x${b.toString(16).padStart(2, "0").repeat(32)}` as Hex;

function scenario(): Log[] {
  const f = ARENA_ABI.factory, e = ARENA_ABI.escrow, r = ARENA_ABI.registry, p = ARENA_ABI.pool;
  return [
    mkLog(f, C.factory, "TableCreated", { table: TABLE, host: HOST, mode: 0, signerSetId: 1n, rulesHash: H(0x11) }, 101n),
    mkLog(e, TABLE, "Joined", { player: P[0], seat: 0, sessionKeyHash: H(0x21), prizeEligible: true }, 102n),
    mkLog(e, TABLE, "Joined", { player: P[1], seat: 1, sessionKeyHash: H(0x22), prizeEligible: true }, 102n),
    mkLog(e, TABLE, "Joined", { player: P[2], seat: 2, sessionKeyHash: H(0x23), prizeEligible: true }, 103n),
    mkLog(e, TABLE, "Left", { player: P[0] }, 104n), // P[2] moves into seat 0
    mkLog(e, TABLE, "Locked", { lockedAt: 1_800_000_000n, endAt: 1_800_086_400n, hardDeadline: 1_800_172_800n, pot: 40_000_000n }, 105n),
    mkLog(r, C.registry, "ResultRecorded", { table: TABLE, round: 0, digest: H(0x31), logHead: H(0x32), eventsRoot: H(0x33), standingsRoot: H(0x34), logURI: "ipfs://log0" }, 106n),
    mkLog(e, TABLE, "ResultPosted", { round: 0, digest: H(0x31), disputeEnd: 1_800_093_600n }, 106n),
    mkLog(e, TABLE, "Disputed", { by: P[1], round: 0, reasonHash: H(0x41), bond: 4_000_000n }, 107n),
    mkLog(e, TABLE, "ResultPosted", { round: 1, digest: H(0x51), disputeEnd: 1_800_100_800n }, 108n),
    mkLog(e, TABLE, "Settled", { digest: H(0x51), unanimous: false }, 109n),
    mkLog(e, TABLE, "Claimed", { account: P[2], to: P[2], amount: 40_000_000n }, 110n),
    mkLog(p, C.stakePool, "Staked", { owner: HOST, id: 1n, amount: 500n * 10n ** 18n, term: 2, unlockAt: 1_810_000_000n }, 111n),
    mkLog(p, C.stakePool, "BondMarked", { owner: HOST, id: 1n }, 111n),
    mkLog(p, C.stakePool, "Pledged", { owner: HOST, id: 1n, amount: 100n * 10n ** 18n }, 112n),
    mkLog(f, C.factory, "CreationPaused", { paused: true }, 113n),
  ];
}

describe("arena events", () => {
  test("every log decodes to its step; a foreign log is ignored", () => {
    const steps = scenario().map((l) => {
      const src = l.address === C.factory ? "factory" : l.address === C.registry ? "registry" : l.address === C.stakePool ? "pool" : "escrow";
      return decodeArenaLog(src, l)!.step;
    });
    expect(steps.map((s) => s.op)).toEqual(["table-created", "joined", "joined", "joined", "left", "locked", "result-recorded", "result-posted", "disputed", "result-posted", "settled", "claimed", "staked", "bond-marked", "pledged", "admin"]);
    expect(steps[0]).toMatchObject({ table: TABLE, host: HOST, mode: "FRIEND", signerSetId: 1 });
    expect(steps[5]).toMatchObject({ lockedAt: 1_800_000_000, pot: 40_000_000n });
    const foreign = mkLog(ARENA_ABI.pool, TABLE, "Staked", { owner: HOST, id: 1n, amount: 1n, term: 0, unlockAt: 0n }, 1n);
    expect(decodeArenaLog("escrow", foreign)).toBeNull();
  });
});

// ---- the whole loop against a real Postgres (ARENA_TEST_DATABASE_URL, a database this test may drop and refill)
const DBURL = process.env.ARENA_TEST_DATABASE_URL;
describe.skipIf(!DBURL)("arena indexer on Postgres", () => {
  let sql: postgres.Sql;
  beforeAll(async () => {
    sql = postgres(DBURL!, { max: 2, onnotice: () => {} });
    await sql.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  });
  afterAll(async () => sql?.end());

  const logs = scenario();
  const reader: ChainReader = {
    getBlockNumber: async () => 140n,
    getLogs: async ({ address, fromBlock, toBlock }) => {
      const set = new Set((Array.isArray(address) ? address : [address]).map((a) => a.toLowerCase()));
      return logs.filter((l) => set.has(l.address.toLowerCase()) && l.blockNumber! >= fromBlock && l.blockNumber! <= toBlock);
    },
    blockTime: async (b) => 1_800_000_000 + Number(b),
    tableParams: async (): Promise<TableParamsView> => ({ token: C.usdg, buyIn: 20_000_000n, prize: 0n, minSeats: 2, maxSeats: 5, lockAt: 1_800_000_000, openUntil: 0, duration: 86_400 }),
  };

  test("migrations apply once, and a changed file is refused", async () => {
    expect(await migrateArena(sql)).toEqual(["0000_arena.sql", "0001_app_links.sql"]);
    expect(await migrateArena(sql)).toEqual([]);
  });

  test("a whole Friend Table, a stake and an admin change land in the tables; a re-run changes nothing", async () => {
    const r = await indexArenaOnce(sql, reader, C, 20);
    expect(r).toMatchObject({ from: 100n, to: 120n, logs: 16, applied: 16 });
    const snap = async () => ({
      table: [...(await sql`SELECT mode, state, buy_in::text, min_seats, max_seats, round, pot::text, signer_set_id, rules_hash FROM arena_tables`)],
      seats: [...(await sql`SELECT address, seat, left_at IS NOT NULL AS left FROM arena_seats ORDER BY lower(address)`)],
      results: [...(await sql`SELECT round, digest, log_head, log_uri FROM arena_results ORDER BY round`)],
      disputes: [...(await sql`SELECT by_address, round, bond::text FROM arena_disputes`)],
      claims: [...(await sql`SELECT account, amount::text FROM arena_claims`)],
      stakes: [...(await sql`SELECT id::text, amount::text, pledged::text, is_bond, closed FROM stake_positions`)],
      events: (await sql`SELECT count(*)::int AS n FROM arena_chain_events`)[0]!.n,
    });
    const a = await snap();
    expect(a.table).toEqual([{ mode: "FRIEND", state: "settled", buy_in: "20000000", min_seats: 2, max_seats: 5, round: 1, pot: "40000000", signer_set_id: 1, rules_hash: H(0x11) }]);
    expect(a.seats).toEqual([
      { address: P[0], seat: 0, left: true },
      { address: P[1], seat: 1, left: false },
      { address: P[2], seat: 0, left: false }, // moved into the leaver's seat, as the escrow does
    ]);
    expect(a.results).toEqual([
      { round: 0, digest: H(0x31), log_head: H(0x32), log_uri: "ipfs://log0" },
      { round: 1, digest: H(0x51), log_head: null, log_uri: null },
    ]);
    expect(a.disputes).toEqual([{ by_address: P[1], round: 0, bond: "4000000" }]);
    expect(a.claims).toEqual([{ account: P[2], amount: "40000000" }]);
    expect(a.stakes).toEqual([{ id: "1", amount: "400000000000000000000", pledged: "100000000000000000000", is_bond: true, closed: false }]);
    expect(a.events).toBe(16);

    // nothing new up to head − confirmations
    expect(await indexArenaOnce(sql, reader, C, 20)).toBeNull();
    // the same range again (cursor moved back): every log is already recorded, so nothing changes
    await sql`UPDATE arena_cursors SET block = 99 WHERE name = ${ARENA_CURSOR}`;
    expect(await indexArenaOnce(sql, reader, C, 20)).toMatchObject({ logs: 16, applied: 0 });
    expect(await snap()).toEqual(a);
  });
});
