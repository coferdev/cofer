/**
 * The Arena indexer: one block range at a time, up to head − confirmations, all in one database transaction with
 * its own cursor (arena_cursors 'arena'), so a range is applied completely or not at all. Each log is recorded once
 * in arena_chain_events (tx hash, log index); a re-run of the same range changes nothing.
 * Order inside a range: TableCreated first (so the new tables' own logs in the same range are fetched), then every
 * other log by (block, log index).
 */
import type { Address, Log } from "viem";
import type postgres from "postgres";
import { ARENA_ABI, type ArenaContracts } from "../chain/contracts";
import { type Source, decodeArenaLog, jsonArgs } from "./arenaEvents";
import { type TableParamsView, applyStep } from "./store";

export const ARENA_CURSOR = "arena";
const CHUNK = 2_000n;
const ADDR_BATCH = 500;

export interface ChainReader {
  getBlockNumber(): Promise<bigint>;
  getLogs(q: { address: Address | Address[]; fromBlock: bigint; toBlock: bigint }): Promise<Log[]>;
  blockTime(block: bigint): Promise<number>; // s
  tableParams(table: Address): Promise<TableParamsView>;
}

export interface RangeResult {
  from: bigint;
  to: bigint;
  logs: number;
  applied: number;
}

export async function indexArenaOnce(sql: postgres.Sql, chain: ChainReader, c: ArenaContracts, confirmations: number): Promise<RangeResult | null> {
  const head = (await chain.getBlockNumber()) - BigInt(confirmations);
  const [cur] = await sql`SELECT block FROM arena_cursors WHERE name = ${ARENA_CURSOR}`;
  const from = cur ? BigInt(cur.block) + 1n : c.startBlock;
  if (from > head) return null;
  const to = from + CHUNK - 1n > head ? head : from + CHUNK - 1n;

  const factoryLogs = await chain.getLogs({ address: c.factory, fromBlock: from, toBlock: to });
  const tagged: { source: Source; log: Log }[] = factoryLogs.map((log) => ({ source: "factory" as const, log }));
  const created = factoryLogs.map((l) => decodeArenaLog("factory", l)).flatMap((d) => (d?.step.op === "table-created" ? [d.step.table] : []));
  const params = new Map<string, TableParamsView>();
  for (const t of created) params.set(t.toLowerCase(), await chain.tableParams(t));

  for (const [source, address] of [["registry", c.registry], ["vault", c.prizeVault], ["pool", c.stakePool]] as const) {
    for (const log of await chain.getLogs({ address, fromBlock: from, toBlock: to })) tagged.push({ source, log });
  }
  const known = (await sql`SELECT address FROM arena_tables WHERE address NOT LIKE 'practice:%'`).map((r) => r.address as Address);
  const tables = [...new Set([...known, ...created])];
  for (let i = 0; i < tables.length; i += ADDR_BATCH) {
    for (const log of await chain.getLogs({ address: tables.slice(i, i + ADDR_BATCH), fromBlock: from, toBlock: to })) tagged.push({ source: "escrow", log });
  }
  tagged.sort((x, y) => {
    const cx = x.source === "factory" ? 0 : 1;
    const cy = y.source === "factory" ? 0 : 1;
    if (cx !== cy) return cx - cy;
    return Number(x.log.blockNumber! - y.log.blockNumber!) || x.log.logIndex! - y.log.logIndex!;
  });

  const times = new Map<bigint, number>();
  for (const { log } of tagged) if (!times.has(log.blockNumber!)) times.set(log.blockNumber!, await chain.blockTime(log.blockNumber!));

  let applied = 0;
  await sql.begin(async (tx) => {
    for (const { source, log } of tagged) {
      const d = decodeArenaLog(source, log);
      if (!d) continue;
      const rows = await tx`
        INSERT INTO arena_chain_events (tx_hash, log_index, block, address, name, args)
        VALUES (${log.transactionHash!}, ${log.logIndex!}, ${log.blockNumber!.toString()}, ${log.address}, ${d.name}, ${tx.json(jsonArgs(d.args))})
        ON CONFLICT DO NOTHING RETURNING tx_hash`;
      if (!rows.length) continue;
      const p = d.step.op === "table-created" ? params.get(d.step.table.toLowerCase()) : undefined;
      await applyStep(tx, d.step, { at: new Date(times.get(log.blockNumber!)! * 1000), block: log.blockNumber!, txHash: log.transactionHash!, params: p });
      applied++;
    }
    await tx`INSERT INTO arena_cursors (name, block) VALUES (${ARENA_CURSOR}, ${to.toString()})
      ON CONFLICT (name) DO UPDATE SET block = EXCLUDED.block`;
  });
  return { from, to, logs: tagged.length, applied };
}

/** The ChainReader over a viem public client. */
export function viemReader(client: {
  getBlockNumber(): Promise<bigint>;
  getLogs(q: { address: Address | Address[]; fromBlock: bigint; toBlock: bigint }): Promise<Log[]>;
  getBlock(q: { blockNumber: bigint }): Promise<{ timestamp: bigint }>;
  readContract(q: { address: Address; abi: typeof ARENA_ABI.escrow; functionName: "params" }): Promise<unknown>;
}): ChainReader {
  return {
    getBlockNumber: () => client.getBlockNumber(),
    getLogs: (q) => client.getLogs(q),
    blockTime: async (b) => Number((await client.getBlock({ blockNumber: b })).timestamp),
    tableParams: async (t) => {
      const p = (await client.readContract({ address: t, abi: ARENA_ABI.escrow, functionName: "params" })) as {
        token: string; buyIn: bigint; prize: bigint; minSeats: number; maxSeats: number; lockAt: bigint; openUntil: bigint; duration: number;
      };
      return { token: p.token, buyIn: p.buyIn, prize: p.prize, minSeats: p.minSeats, maxSeats: p.maxSeats, lockAt: Number(p.lockAt), openUntil: Number(p.openUntil), duration: Number(p.duration) };
    },
  };
}
