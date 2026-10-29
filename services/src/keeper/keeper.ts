/**
 * Self-hosted keeper (RHC has no Chainlink Automation or Gelato). Everything it calls is
 * permissionless, so liveness never depends on this process: members can always exit, and anyone
 * can execute a passed proposal.
 */
import { Worker } from "bullmq";
import { and, inArray, lt, lte, eq, sql } from "drizzle-orm";
import { getAddress, type Address } from "viem";
import { db, schema } from "../db/client";
import { aggregatorAbi, erc20Abi, factoryAbi, factoryAddress, potAbi, publicClient } from "../chain/clients";
import { Q, queues, redis, enqueueRelay, enqueueNotify } from "../queues";
import { fetchCanonicalStocks } from "../stocks/canonical";
import { env } from "../env";

export async function expireProposals(now = Math.floor(Date.now() / 1000)) {
  const rows = await db()
    .update(schema.proposals)
    .set({ status: "expired" })
    .where(and(lt(schema.proposals.deadline, now), inArray(schema.proposals.status, ["collecting", "ready", "queued"])))
    .returning({ id: schema.proposals.id });
  for (const r of rows) await enqueueNotify(r.id);
  return rows.length;
}

/** Backup for delayed relay jobs: anything whose exit window has passed gets executed. */
export async function sweepQueued(now = Math.floor(Date.now() / 1000)) {
  const rows = await db()
    .select({ id: schema.proposals.id })
    .from(schema.proposals)
    .where(and(eq(schema.proposals.status, "queued"), lte(schema.proposals.queuedEta, now)));
  for (const r of rows) await enqueueRelay(r.id);
  const ready = await db().select({ id: schema.proposals.id }).from(schema.proposals).where(eq(schema.proposals.status, "ready"));
  for (const r of ready) await enqueueRelay(r.id);
  return rows.length + ready.length;
}

/** Refresh canonical Stock Tokens + pending multipliers (corporate actions) from the issuer API. */
export async function refreshStocks() {
  const list = await fetchCanonicalStocks(env().STOCK_API_BASE, env().CHAIN_ID);
  for (const s of list) {
    let listed = false;
    try {
      const info = await publicClient().readContract({ address: factoryAddress(), abi: factoryAbi, functionName: "assetInfo", args: [s.address] });
      listed = info.listed;
    } catch {
      /* not listed */
    }
    await db()
      .insert(schema.assets)
      .values({
        address: s.address,
        symbol: s.symbol,
        decimals: s.decimals,
        isStock: true,
        currentMultiplier: s.currentMultiplier,
        pendingMultiplier: s.pendingMultiplier ?? null,
        pendingEffectiveAt: s.pendingEffectiveAt ? new Date(s.pendingEffectiveAt) : null,
        listedOnChain: listed,
        status: s.status ?? null,
      })
      .onConflictDoUpdate({
        target: schema.assets.address,
        set: {
          symbol: s.symbol,
          currentMultiplier: s.currentMultiplier,
          pendingMultiplier: s.pendingMultiplier ?? null,
          pendingEffectiveAt: s.pendingEffectiveAt ? new Date(s.pendingEffectiveAt) : null,
          listedOnChain: listed,
          status: s.status ?? null,
          refreshedAt: new Date(),
        },
      });
  }
  return list.length;
}

/** Holdings snapshot per pot (display only; valuation = raw x feed, multiplier never re-applied). */
export async function refreshHoldings() {
  const client = publicClient();
  const pots = await db().select().from(schema.pots);
  for (const p of pots) {
    const pot = getAddress(p.address);
    const held = await client.readContract({ address: pot, abi: potAbi, functionName: "heldAssets" });
    for (const asset of held) {
      const [bal, reserved] = await Promise.all([
        client.readContract({ address: asset, abi: erc20Abi, functionName: "balanceOf", args: [pot] }),
        client.readContract({ address: pot, abi: potAbi, functionName: "reserved", args: [asset] }),
      ]);
      let value: string | null = null;
      try {
        const v = await client.readContract({ address: factoryAddress(), abi: factoryAbi, functionName: "valueInUsdg", args: [asset, bal - reserved] });
        value = v.toString();
      } catch {
        value = null; // stale feed (e.g. US market closed past maxStaleness): shown as "price paused"
      }
      await db()
        .insert(schema.holdings)
        .values({ pot, asset, rawBalance: bal.toString(), reserved: reserved.toString(), valueUsdg: value })
        .onConflictDoUpdate({
          target: [schema.holdings.pot, schema.holdings.asset],
          set: { rawBalance: bal.toString(), reserved: reserved.toString(), valueUsdg: value, updatedAt: new Date() },
        });
    }
    await db().execute(sql`delete from holdings where pot = ${pot} and not (asset = any(${held.map((a) => a as string)}))`);
  }
}

export async function feedHealth(): Promise<{ asset: string; ageSec: number }[]> {
  const client = publicClient();
  const listed = await db().select().from(schema.assets).where(eq(schema.assets.listedOnChain, true));
  const now = Math.floor(Date.now() / 1000);
  const out: { asset: string; ageSec: number }[] = [];
  for (const a of listed) {
    if (!a.feed) continue;
    const r = await client.readContract({ address: a.feed as Address, abi: aggregatorAbi, functionName: "latestRoundData" });
    out.push({ asset: a.symbol, ageSec: now - Number(r[3]) });
  }
  return out;
}

export async function scheduleKeeper() {
  const q = queues().keeper;
  await q.upsertJobScheduler("expire", { every: 60_000 }, { name: "expire" });
  await q.upsertJobScheduler("sweep", { every: 30_000 }, { name: "sweep" });
  await q.upsertJobScheduler("stocks", { every: 3_600_000 }, { name: "stocks" });
  await q.upsertJobScheduler("holdings", { every: 300_000 }, { name: "holdings" });
  await q.upsertJobScheduler("feeds", { every: 900_000 }, { name: "feeds" });
}

export function startKeeper() {
  return new Worker(
    Q.keeper,
    async (job) => {
      switch (job.name) {
        case "expire":
          return expireProposals();
        case "sweep":
          return sweepQueued();
        case "stocks":
          return refreshStocks();
        case "holdings":
          return refreshHoldings();
        case "feeds":
          return feedHealth();
      }
    },
    { connection: redis(), concurrency: 1 },
  );
}
