/**
 * Log indexer (viem getLogs polling with a DB cursor). RHC makes ~10 blocks/s, so we index up to
 * head - CONFIRMATIONS in chunks and keep everything idempotent on (txHash, logIndex).
 * Projections keep pots/members/proposals in sync; the chain is always the source of truth.
 */
import { eq, sql } from "drizzle-orm";
import { decodeEventLog, getAddress, type Address, type Log } from "viem";
import { db, schema } from "../db/client";
import { factoryAbi, factoryAddress, potAbi, publicClient } from "../chain/clients";
import { env } from "../env";
import { enqueueNotify, enqueueChatMessage } from "../queues";
import { logError } from "../core/errors";

const CHUNK = 2_000n;
const CURSOR = "main";

export async function indexOnce(): Promise<bigint> {
  const client = publicClient();
  const head = (await client.getBlockNumber()) - BigInt(env().CONFIRMATIONS);
  const cur = await db().query.cursors.findFirst({ where: eq(schema.cursors.name, CURSOR) });
  const from = cur ? cur.block + 1n : env().START_BLOCK;
  if (from > head) return head;
  const to = from + CHUNK - 1n > head ? head : from + CHUNK - 1n;

  const factoryLogs = await client.getLogs({ address: factoryAddress(), fromBlock: from, toBlock: to });
  for (const log of factoryLogs) await handleFactoryLog(log);

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

async function record(log: Log, name: string, args: unknown) {
  await db()
    .insert(schema.chainEvents)
    .values({
      txHash: log.transactionHash!,
      logIndex: log.logIndex!,
      block: log.blockNumber!,
      address: getAddress(log.address),
      name,
      args: JSON.parse(JSON.stringify(args, (_k, v) => (typeof v === "bigint" ? v.toString() : v))),
    })
    .onConflictDoNothing();
}

async function handleFactoryLog(log: Log) {
  let ev;
  try {
    ev = decodeEventLog({ abi: factoryAbi, data: log.data, topics: log.topics });
  } catch {
    return;
  }
  await record(log, ev.eventName, ev.args);
  if (ev.eventName === "PotCreated") {
    // The bot inserts the pot row (it knows the chat); here we only backfill the block.
    await db().update(schema.pots).set({ createdBlock: log.blockNumber! }).where(eq(schema.pots.address, getAddress(ev.args.pot)));
  }
}

export async function handlePotLog(log: Log) {
  let ev;
  try {
    ev = decodeEventLog({ abi: potAbi, data: log.data, topics: log.topics });
  } catch {
    return;
  }
  await record(log, ev.eventName, ev.args);
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
    case "ProposalQueued":
      await d.update(schema.proposals).set({ status: "queued", queuedEta: Number(ev.args.eta) }).where(eq(schema.proposals.id, ev.args.digest));
      await enqueueNotify(ev.args.digest);
      break;
    case "ProposalExecuted":
      await d.update(schema.proposals).set({ status: "executed", txHash: log.transactionHash! }).where(eq(schema.proposals.id, ev.args.digest));
      await enqueueNotify(ev.args.digest);
      break;
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
