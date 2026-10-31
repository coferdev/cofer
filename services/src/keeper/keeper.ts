/**
 * Self-hosted keeper (RHC has no Chainlink Automation or Gelato). Everything it calls is
 * permissionless, so liveness never depends on this process: members can always exit, and anyone
 * can execute a passed proposal.
 */
import { and, inArray, lt, lte, eq, notInArray } from "drizzle-orm";
import { getAddress, zeroAddress, type Address } from "viem";
import { db, schema } from "../db/client";
import { aggregatorAbi, erc20Abi, factoryAbi, factoryAddress, potAbi, publicClient } from "../chain/clients";
import { Q, queues, enqueueRelay, enqueueNotify, startWorker } from "../queues";
import { fetchCanonicalStocks, type CanonicalStock } from "../stocks/canonical";
import { env } from "../env";
import { logError } from "../core/errors";
import { feedProblems, type FeedNow } from "../core/feedHealth";
import { continuityAlertKey, continuityStep, pendingFrom, type Pending, type Reading } from "../core/continuity";
import { alertDeps, checkAlert, type AlertDeps } from "./alerts";

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

/**
 * The assets row for one canonical stock. `info` is the factory's assetInfo, or undefined when the
 * chain could not be read: then a new row starts as not listed, and an existing row keeps its
 * listed flag and feed (a hiccup never hides a listed stock from /buy).
 */
export function stockRow(s: CanonicalStock, info: { listed: boolean; feed: Address } | undefined) {
  const fromApi = {
    symbol: s.symbol,
    currentMultiplier: s.currentMultiplier,
    pendingMultiplier: s.pendingMultiplier ?? null,
    pendingEffectiveAt: s.pendingEffectiveAt ? new Date(s.pendingEffectiveAt) : null,
    status: s.status ?? null,
  };
  const fromChain = info ? { listedOnChain: info.listed, feed: info.listed && info.feed !== zeroAddress ? getAddress(info.feed) : null } : {};
  return {
    insert: { address: s.address, decimals: s.decimals, isStock: true, listedOnChain: false, feed: null, ...fromApi, ...fromChain },
    update: { ...fromApi, ...fromChain, refreshedAt: new Date() },
  };
}

/** Refresh canonical Stock Tokens + pending multipliers (corporate actions) from the issuer API. */
export async function refreshStocks() {
  const list = await fetchCanonicalStocks(env().STOCK_API_BASE, env().CHAIN_ID);
  for (const s of list) {
    let info: { listed: boolean; feed: Address } | undefined;
    try {
      // a mapping read: an unlisted asset returns listed = false, so any error here is the chain, not "not listed"
      info = await publicClient().readContract({ address: factoryAddress(), abi: factoryAbi, functionName: "assetInfo", args: [s.address] });
    } catch (e) {
      logError("cofer-keeper stocks", e);
    }
    const row = stockRow(s, info);
    await db().insert(schema.assets).values(row.insert).onConflictDoUpdate({ target: schema.assets.address, set: row.update });
  }
  return list.length;
}

/** Holdings snapshot per pot (display only; valuation = raw x feed, multiplier never re-applied). */
/**
 * This pot's holdings rows for assets it no longer holds. notInArray sends one value per asset
 * (`asset not in ($2, $3)`); a JS array inside a sql`` template is not a Postgres array.
 */
export function staleHoldings(pot: Address, held: readonly Address[]) {
  return and(eq(schema.holdings.pot, pot), notInArray(schema.holdings.asset, [...held]));
}

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
    await db().delete(schema.holdings).where(staleHoldings(pot, held));
  }
}

export interface FeedTarget {
  symbol: string;
  asset: Address;
}

export interface FeedHealthDeps {
  targets(): Promise<FeedTarget[]>;
  /** The feed now, or null if the factory has no feed for this asset. Throws if the chain cannot be read. */
  read(asset: Address): Promise<FeedNow | null>;
  alerts: AlertDeps;
  now(): number;
}

function feedHealthDeps(): FeedHealthDeps {
  const client = publicClient();
  return {
    async targets() {
      const listed = await db().select().from(schema.assets).where(eq(schema.assets.listedOnChain, true));
      return [{ symbol: "USDG", asset: env().USDG_ADDRESS }, ...listed.map((a) => ({ symbol: a.symbol, asset: getAddress(a.address) }))];
    },
    async read(asset) {
      // read live, so a feed changed on the factory (48h timelock) is checked against its new limit
      const info = await client.readContract({ address: factoryAddress(), abi: factoryAbi, functionName: "assetInfo", args: [asset] });
      if (!info.listed || info.feed === zeroAddress) return null;
      const r = await client.readContract({ address: info.feed, abi: aggregatorAbi, functionName: "latestRoundData" });
      return { answer: r[1], updatedAt: Number(r[3]), maxStaleness: info.maxStaleness };
    },
    alerts: alertDeps(),
    now: () => Math.floor(Date.now() / 1000),
  };
}

/**
 * Checks every listed feed (USDG included) and opens or clears its alerts. A feed that cannot be
 * read is logged and its alerts are left as they are: an RPC hiccup neither raises nor clears one.
 */
export async function feedHealth(deps: FeedHealthDeps = feedHealthDeps()): Promise<{ asset: string; ageSec: number }[]> {
  const out: { asset: string; ageSec: number }[] = [];
  for (const t of await deps.targets()) {
    let f: FeedNow | null;
    try {
      f = await deps.read(t.asset);
    } catch (e) {
      logError("cofer-keeper feeds", e);
      continue;
    }
    if (!f) continue;
    const now = deps.now();
    for (const p of feedProblems(t.symbol, t.asset, f, now)) await checkAlert(p.key, p.problem, deps.alerts);
    out.push({ asset: t.symbol, ageSec: now - f.updatedAt });
  }
  return out;
}

export interface ContinuityTarget {
  symbol: string;
  asset: Address;
  pending: Pending | null;
}

export interface ContinuityDeps {
  targets(): Promise<ContinuityTarget[]>;
  /** Feed price and token multiplier read together, or null if the factory has no feed. Throws if the chain cannot be read. */
  read(asset: Address): Promise<Reading | null>;
  load(asset: Address): Promise<{ base: Reading; mismatchSince: number | null } | null>;
  save(asset: Address, base: Reading, mismatchSince: number | null): Promise<void>;
  alerts: AlertDeps;
  now(): number;
}

function continuityDeps(): ContinuityDeps {
  const client = publicClient();
  return {
    async targets() {
      const rows = await db()
        .select()
        .from(schema.assets)
        .where(and(eq(schema.assets.listedOnChain, true), eq(schema.assets.isStock, true)));
      return rows.map((a) => ({ symbol: a.symbol, asset: getAddress(a.address), pending: pendingFrom(a.pendingMultiplier, a.pendingEffectiveAt) }));
    },
    async read(asset) {
      const info = await client.readContract({ address: factoryAddress(), abi: factoryAbi, functionName: "assetInfo", args: [asset] });
      if (!info.listed || info.feed === zeroAddress) return null;
      // read at the same moment, so a lagging issuer list never makes a split look like a mismatch
      const [r, multiplier] = await Promise.all([
        client.readContract({ address: info.feed, abi: aggregatorAbi, functionName: "latestRoundData" }),
        client.readContract({ address: asset, abi: erc20Abi, functionName: "uiMultiplier" }),
      ]);
      return { answer: r[1], updatedAt: Number(r[3]), multiplier };
    },
    async load(asset) {
      const row = await db().query.feedReadings.findFirst({ where: eq(schema.feedReadings.asset, asset) });
      if (!row) return null;
      return { base: { answer: BigInt(row.answer), updatedAt: row.feedUpdatedAt, multiplier: BigInt(row.multiplier) }, mismatchSince: row.mismatchSince };
    },
    async save(asset, base, mismatchSince) {
      const v = { answer: base.answer.toString(), feedUpdatedAt: base.updatedAt, multiplier: base.multiplier.toString(), mismatchSince, seenAt: new Date() };
      await db()
        .insert(schema.feedReadings)
        .values({ asset, ...v })
        .onConflictDoUpdate({ target: schema.feedReadings.asset, set: v });
    },
    alerts: alertDeps(),
    now: () => Math.floor(Date.now() / 1000),
  };
}

/**
 * Multiplier continuity alert for every listed Stock Token (see core/continuity.ts). A token that
 * cannot be read is logged and left as it was; a bad price is skipped (feed health reports it).
 */
export async function multiplierContinuity(deps: ContinuityDeps = continuityDeps()): Promise<{ asset: string; problem: boolean }[]> {
  const out: { asset: string; problem: boolean }[] = [];
  for (const t of await deps.targets()) {
    let now: Reading | null;
    try {
      now = await deps.read(t.asset);
    } catch (e) {
      logError("cofer-keeper continuity", e);
      continue;
    }
    if (!now || now.answer <= 0n || now.multiplier <= 0n) continue;
    const prev = await deps.load(t.asset);
    const r = continuityStep({ symbol: t.symbol, base: prev?.base ?? null, mismatchSince: prev?.mismatchSince ?? null, now, pending: t.pending, nowSec: deps.now() });
    await deps.save(t.asset, r.base, r.mismatchSince);
    if (r.accepted) await deps.alerts.send(r.accepted);
    await checkAlert(continuityAlertKey(t.asset), r.problem, deps.alerts);
    out.push({ asset: t.symbol, problem: r.problem !== null });
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
  return startWorker(
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
          return { feeds: await feedHealth(), continuity: await multiplierContinuity() };
      }
    },
    { concurrency: 1 },
  );
}
