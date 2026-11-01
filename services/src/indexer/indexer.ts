/**
 * Log indexer (viem getLogs polling with a DB cursor). RHC makes ~10 blocks/s, so we index up to
 * head - CONFIRMATIONS in chunks and keep everything idempotent on (txHash, logIndex).
 * Projections keep pots/members/proposals in sync; the chain is always the source of truth.
 */
import { and, eq, sql } from "drizzle-orm";
import { decodeEventLog, getAddress, type Address, type Log } from "viem";
import { onVoteEvent, type UnknownVoteDeps, type VoteEvent } from "./unknownVotes";
import { onAdminEvent, type AdminEvent, type AdminEventDeps } from "./adminEvents";
import { alertDeps } from "../keeper/alerts";
import { db, schema } from "../db/client";
import { factoryAbi, factoryAddress, feeRouterAbi, potAbi, publicClient } from "../chain/clients";
import { env } from "../env";
import { enqueueNotify, enqueueChatMessage } from "../queues";
import { logError } from "../core/errors";

const CHUNK = 2_000n;
export const CURSOR = "main"; // also read by the keeper's lag check

export async function indexOnce(): Promise<bigint> {
  const client = publicClient();
  const head = (await client.getBlockNumber()) - BigInt(env().CONFIRMATIONS);
  const cur = await db().query.cursors.findFirst({ where: eq(schema.cursors.name, CURSOR) });
  const from = cur ? cur.block + 1n : env().START_BLOCK;
  if (from > head) return head;
  const to = from + CHUNK - 1n > head ? head : from + CHUNK - 1n;

  const factoryLogs = await client.getLogs({ address: factoryAddress(), fromBlock: from, toBlock: to });
  for (const log of factoryLogs) await handleFactoryLog(log);

  // FeeRouter admin changes (sinks, plan price); its address is immutable in the factory, read once
  feeRouter ??= (await client.readContract({ address: factoryAddress(), abi: factoryAbi, functionName: "feeRouter" })) as Address;
  const routerLogs = await client.getLogs({ address: feeRouter, fromBlock: from, toBlock: to });
  for (const log of routerLogs) await handleFeeRouterLog(log);

  const pots = (await db().select({ a: schema.pots.address }).from(schema.pots)).map((r) => r.a as Address);
  if (pots.length) {
    // getLogs accepts an address array; split to stay under provider limits
    for (let i = 0; i < pots.length; i += 500) {
      const logs = await client.getLogs({ address: pots.slice(i, i + 500), fromBlock: from, toBlock: to });
      for (const log of logs) await handlePotLog(log);
    }
  }

  await db()
    .insert(schema.cursors)
    .values({ name: CURSOR, block: to })
    .onConflictDoUpdate({ target: schema.cursors.name, set: { block: to } });
  return to;
}

/** Records the log once. Returns true only the first time (false on a re-run of the same block range). */
async function record(log: Log, name: string, args: unknown): Promise<boolean> {
  const rows = await db()
    .insert(schema.chainEvents)
    .values({
      txHash: log.transactionHash!,
      logIndex: log.logIndex!,
      block: log.blockNumber!,
      address: getAddress(log.address),
      name,
      args: JSON.parse(JSON.stringify(args, (_k, v) => (typeof v === "bigint" ? v.toString() : v))),
    })
    .onConflictDoNothing()
    .returning({ txHash: schema.chainEvents.txHash });
  return rows.length > 0;
}

/** Forgets a recorded log, so the next run handles it again (used when its alert could not be sent). */
async function unrecord(log: Log) {
  await db()
    .delete(schema.chainEvents)
    .where(and(eq(schema.chainEvents.txHash, log.transactionHash!), eq(schema.chainEvents.logIndex, log.logIndex!)));
}

const unknownVoteDeps: UnknownVoteDeps = {
  chatOf: async (pot) => (await db().query.pots.findFirst({ where: eq(schema.pots.address, pot) }))?.chatId ?? null,
  sendGroup: (chatId, text) => enqueueChatMessage(chatId, text),
  sendOps: (text) => alertDeps().send(text),
};

/** Alerts about a queued/executed vote the bot did not create; on a failed send the log is handled again next run. */
async function alertIfUnknown(log: Log, pot: Address, event: VoteEvent, isNew: boolean, known: boolean) {
  try {
    await onVoteEvent(unknownVoteDeps, { pot, event, isNew, known });
  } catch (e) {
    await unrecord(log);
    throw e;
  }
}

async function handleFactoryLog(log: Log) {
  let ev;
  try {
    ev = decodeEventLog({ abi: factoryAbi, data: log.data, topics: log.topics });
  } catch {
    return;
  }
  const isNew = await record(log, ev.eventName, ev.args);
  if (ev.eventName === "PotCreated") {
    // The bot inserts the pot row (it knows the chat); here we only backfill the block.
    await db().update(schema.pots).set({ createdBlock: log.blockNumber! }).where(eq(schema.pots.address, getAddress(ev.args.pot)));
    return;
  }
  await alertAdmin(log, { source: "factory", name: ev.eventName, args: ev.args as Record<string, unknown>, txHash: log.transactionHash! }, isNew);
}

let feeRouter: Address | undefined;

async function handleFeeRouterLog(log: Log) {
  let ev;
  try {
    ev = decodeEventLog({ abi: feeRouterAbi, data: log.data, topics: log.topics });
  } catch {
    return;
  }
  const isNew = await record(log, ev.eventName, ev.args);
  await alertAdmin(log, { source: "feeRouter", name: ev.eventName, args: ev.args as Record<string, unknown>, txHash: log.transactionHash! }, isNew);
}

const adminDeps: AdminEventDeps = {
  sendOps: (text) => alertDeps().send(text),
  groupChats: async () => (await db().select({ c: schema.pots.chatId }).from(schema.pots)).map((r) => r.c),
  sendGroup: (chatId, text) => enqueueChatMessage(chatId, text),
  symbolOf: async (asset) => (await db().query.assets.findFirst({ where: eq(schema.assets.address, getAddress(asset)) }))?.symbol ?? null,
};

/** Admin-change alerts (ops, plus groups for queued changes); on a failed send the log is handled again next run. */
async function alertAdmin(log: Log, ev: AdminEvent, isNew: boolean) {
  try {
    await onAdminEvent(adminDeps, ev, isNew);
  } catch (e) {
    await unrecord(log);
    throw e;
  }
}

export async function handlePotLog(log: Log) {
  let ev;
  try {
    ev = decodeEventLog({ abi: potAbi, data: log.data, topics: log.topics });
  } catch {
    return;
  }
  const isNew = await record(log, ev.eventName, ev.args);
  const pot = getAddress(log.address);
  const d = db();
  switch (ev.eventName) {
    case "MemberAdded":
      await d
        .insert(schema.members)
        .values({ pot, address: getAddress(ev.args.member) })
        .onConflictDoUpdate({ target: [schema.members.pot, schema.members.address], set: { active: true } });
      break;
    case "MemberRemoved":
      await d
        .update(schema.members)
        .set({ active: false, shares: "0", allowance: "0", period: 0 })
        .where(sql`${schema.members.pot} = ${pot} and ${schema.members.address} = ${getAddress(ev.args.member)}`);
      break;
    case "Deposited":
      await bumpShares(pot, getAddress(ev.args.member), ev.args.shares);
      break;
    case "Exited":
      await bumpShares(pot, getAddress(ev.args.member), -ev.args.shares);
      break;
    case "AllowanceSet":
      await d
        .update(schema.members)
        .set({ allowance: ev.args.amount.toString(), period: Number(ev.args.period), spent: "0", periodStart: Number((await blockTime(log)) ?? 0) })
        .where(sql`${schema.members.pot} = ${pot} and ${schema.members.address} = ${getAddress(ev.args.member)}`);
      break;
    case "ThresholdSet":
      await d.update(schema.pots).set({ threshold: Number(ev.args.threshold), thresholdBps: Number(ev.args.thresholdBps) }).where(eq(schema.pots.address, pot));
      break;
    case "ConfigSet":
      await d
        .update(schema.pots)
        .set({ guardDelay: Number(ev.args.guardDelay), maxSlipBps: Number(ev.args.maxSlipBps), entrySpreadBps: Number(ev.args.entrySpreadBps), depositsOpen: ev.args.depositsOpen })
        .where(eq(schema.pots.address, pot));
      break;
    case "EpochBumped":
      await d.update(schema.pots).set({ epoch: ev.args.epoch }).where(eq(schema.pots.address, pot));
      // every still-open proposal signed under the old epoch can no longer execute
      await d.execute(sql`update proposals set status = 'stale' where pot = ${pot} and epoch < ${ev.args.epoch} and status in ('collecting','ready','queued')`);
      break;
    case "VoteRevoked":
      await d
        .update(schema.signatures)
        .set({ revoked: true })
        .where(sql`${schema.signatures.proposalId} = ${ev.args.digest} and ${schema.signatures.signer} = ${getAddress(ev.args.member)}`);
      await enqueueNotify(ev.args.digest);
      break;
    case "ProposalQueued": {
      const hit = await d
        .update(schema.proposals)
        .set({ status: "queued", queuedEta: Number(ev.args.eta) })
        .where(eq(schema.proposals.id, ev.args.digest))
        .returning({ id: schema.proposals.id });
      if (hit.length > 0) await enqueueNotify(ev.args.digest);
      const event: VoteEvent = { name: "ProposalQueued", digest: ev.args.digest, kind: Number(ev.args.kind), eta: BigInt(ev.args.eta) };
      await alertIfUnknown(log, pot, event, isNew, hit.length > 0);
      break;
    }
    case "ProposalExecuted": {
      const hit = await d
        .update(schema.proposals)
        .set({ status: "executed", txHash: log.transactionHash! })
        .where(eq(schema.proposals.id, ev.args.digest))
        .returning({ id: schema.proposals.id });
      if (hit.length > 0) await enqueueNotify(ev.args.digest);
      const event: VoteEvent = { name: "ProposalExecuted", digest: ev.args.digest, kind: Number(ev.args.kind) };
      await alertIfUnknown(log, pot, event, isNew, hit.length > 0);
      break;
    }
    case "ExitOwed": {
      const p = await d.query.pots.findFirst({ where: eq(schema.pots.address, pot) });
      if (p) await enqueueChatMessage(p.chatId, "One token could not be sent during an exit (it may be paused by its issuer). It is set aside for the member and can be claimed any time with /claim.");
      break;
    }
  }
}

async function bumpShares(pot: Address, member: Address, delta: bigint) {
  await db().execute(
    sql`update members set shares = (shares::numeric + ${delta.toString()}::numeric) where pot = ${pot} and address = ${member}`,
  );
  await db().execute(sql`update pots set total_shares = (total_shares::numeric + ${delta.toString()}::numeric) where address = ${pot}`);
}

async function blockTime(log: Log) {
  const b = await publicClient().getBlock({ blockNumber: log.blockNumber! });
  return b.timestamp;
}

export async function startIndexer(signal?: AbortSignal) {
  while (!signal?.aborted) {
    try {
      const before = Date.now();
      await indexOnce();
      const spent = Date.now() - before;
      await Bun.sleep(Math.max(250, 1000 - spent));
    } catch (e) {
      logError("indexer", e);
      await Bun.sleep(3000);
    }
  }
}
