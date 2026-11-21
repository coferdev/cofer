/**
 * Observe-only indexing (INDEXER_OBSERVE_ONLY=1), for anyone running Cofer's indexer on their own database to check
 * Cofer's public data independently (docs/ops/run-your-own-indexer.md). It records into chain_events every log of the
 * factory, the fee router and every group account the factory created (found from its PotCreated logs, not from the
 * bot's records), and does nothing else: no projections, no alerts, no messages, no Telegram data.
 */
import { eq, sql } from "drizzle-orm";
import { decodeEventLog, getAddress, type Abi, type Address, type Log } from "viem";
import { db, schema } from "../db/client";
import { factoryAbi, factoryAddress, feeRouterAbi, potAbi, publicClient } from "../chain/clients";
import { env } from "../env";
import { CURSOR, record } from "./indexer";

const CHUNK = 2_000n;
let feeRouter: Address | undefined;

/** Decodes a log with the contract's ABI and records it once; logs the ABI does not know are left out. */
async function keep(log: Log, abi: Abi): Promise<string | null> {
  let ev: { eventName: string; args: unknown };
  try {
    ev = decodeEventLog({ abi, data: log.data, topics: log.topics }) as never;
  } catch {
    return null;
  }
  await record(log, ev.eventName, ev.args);
  return ev.eventName;
}

/** The group accounts the factory created, from the recorded PotCreated logs. */
export async function observedPots(): Promise<Address[]> {
  const rows = await db()
    .select({ pot: sql<string>`${schema.chainEvents.args}->>'pot'` })
    .from(schema.chainEvents)
    .where(eq(schema.chainEvents.name, "PotCreated"));
  return [...new Set(rows.map((r) => getAddress(r.pot)))];
}

export async function observeOnce(): Promise<bigint> {
  const client = publicClient();
  const head = (await client.getBlockNumber()) - BigInt(env().CONFIRMATIONS);
  const cur = await db().query.cursors.findFirst({ where: eq(schema.cursors.name, CURSOR) });
  const from = cur ? cur.block + 1n : env().START_BLOCK;
  if (from > head) return head;
  const to = from + CHUNK - 1n > head ? head : from + CHUNK - 1n;
  for (const log of await client.getLogs({ address: factoryAddress(), fromBlock: from, toBlock: to })) await keep(log, factoryAbi as Abi);
  feeRouter ??= (await client.readContract({ address: factoryAddress(), abi: factoryAbi, functionName: "feeRouter" })) as Address;
  for (const log of await client.getLogs({ address: feeRouter, fromBlock: from, toBlock: to })) await keep(log, feeRouterAbi as Abi);
  const pots = await observedPots();
  for (let i = 0; i < pots.length; i += 500) for (const log of await client.getLogs({ address: pots.slice(i, i + 500), fromBlock: from, toBlock: to })) await keep(log, potAbi as Abi);
  await db().insert(schema.cursors).values({ name: CURSOR, block: to }).onConflictDoUpdate({ target: schema.cursors.name, set: { block: to } });
  return to;
}
