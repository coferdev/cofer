/**
 * Self-hosted keeper (RHC has no Chainlink Automation or Gelato). Everything it calls is
 * permissionless, so liveness never depends on this process: members can always exit, and anyone
 * can execute a passed proposal.
 */
import { and, inArray, like, lt, lte, eq, notInArray } from "drizzle-orm";
import { getAddress, zeroAddress, type Address } from "viem";
import { db, schema } from "../db/client";
import { aggregatorAbi, erc20Abi, factoryAbi, factoryAddress, feeRouterAbi, potAbi, publicClient, relayerClient } from "../chain/clients";
import { Q, queues, enqueueNotify, ensureRelay, startWorker } from "../queues";
import { fetchCanonicalStocks, type CanonicalStock } from "../stocks/canonical";
import { env } from "../env";
import { errorKind, logError } from "../core/errors";
import { feedProblems, type FeedNow } from "../core/feedHealth";
import { continuityAlertKey, continuityStep, pendingFrom, type Pending, type Reading } from "../core/continuity";
import { alertDeps, checkAlert, type AlertDeps } from "./alerts";
import { watchJobFailures } from "./jobAlerts";
import { HEALTH_EVERY_MS, healthPing } from "./health";
import { voteAlertClears } from "../relayer/voteAlerts";
import { relayerFundsProblem } from "../core/relayerFunds";
import { INDEXER_LAG_ALERT, indexerLagProblem } from "../core/indexerLag";
import { ROLES_ALERT, roleProblem, type RoleState } from "../core/roles";
import { CURSOR } from "../indexer/indexer";

export async function expireProposals(now = Math.floor(Date.now() / 1000)) {
  const rows = await db()
    .update(schema.proposals)
    .set({ status: "expired" })
    .where(and(lt(schema.proposals.deadline, now), inArray(schema.proposals.status, ["collecting", "ready", "queued"])))
    .returning({ id: schema.proposals.id });
  for (const r of rows) await enqueueNotify(r.id);
  return rows.length;
}

/**
 * Backup for relay jobs: every passed vote that should run now (ready, or queued past its exit
 * window) gets a live relay job. A lost job is added again; one that failed all its tries is
 * retried RELAY_RETRY_AFTER_MS later; one still waiting or running is left alone.
 */
export async function sweepQueued(now = Math.floor(Date.now() / 1000), ensure: (id: string, at?: number) => Promise<unknown> = ensureRelay) {
  const queued = await db()
    .select({ id: schema.proposals.id, queuedEta: schema.proposals.queuedEta })
    .from(schema.proposals)
    .where(and(eq(schema.proposals.status, "queued"), lte(schema.proposals.queuedEta, now)));
  const ready = await db().select({ id: schema.proposals.id }).from(schema.proposals).where(eq(schema.proposals.status, "ready"));
  // the queued run's job is the one the relayer scheduled at eta + 2 (relayer.ts); a ready vote's is its first
  const due = [...queued.map((r) => ({ id: r.id, at: r.queuedEta === null ? undefined : r.queuedEta + 2 })), ...ready.map((r) => ({ id: r.id, at: undefined }))];
  let first: unknown;
  for (const d of due) {
    try {
      await ensure(d.id, d.at);
    } catch (e) {
      first ??= e; // e.g. the job changed state meanwhile; the next sweep (30s) looks again
    }
  }
  if (first !== undefined) throw first;
  return due.length;
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

/**
 * This pot's holdings rows for assets it no longer holds. notInArray sends one value per asset
 * (`asset not in ($2, $3)`); a JS array inside a sql`` template is not a Postgres array.
 */
export function staleHoldings(pot: Address, held: readonly Address[]) {
  return and(eq(schema.holdings.pot, pot), notInArray(schema.holdings.asset, [...held]));
}

/**
 * A holding's value, or null for "price paused" when the factory refuses to price it (stale or bad
 * feed). A chain failure is not a paused price: it is thrown, so the pot keeps its previous rows.
 */
export async function valueOrPaused(read: () => Promise<bigint>): Promise<bigint | null> {
  try {
    return await read();
  } catch (e) {
    if (errorKind(e) === "rpc") throw e;
    return null; // e.g. US market closed past maxStaleness
  }
}

/** Holdings snapshot for one pot (display only; valuation = raw x feed, multiplier never re-applied). */
export async function refreshPotHoldings(pot: Address) {
  const client = publicClient();
  const held = await client.readContract({ address: pot, abi: potAbi, functionName: "heldAssets" });
  for (const asset of held) {
    const [bal, reserved] = await Promise.all([
      client.readContract({ address: asset, abi: erc20Abi, functionName: "balanceOf", args: [pot] }),
      client.readContract({ address: pot, abi: potAbi, functionName: "reserved", args: [asset] }),
    ]);
    const v = await valueOrPaused(() => client.readContract({ address: factoryAddress(), abi: factoryAbi, functionName: "valueInUsdg", args: [asset, bal - reserved] }));
    const value = v === null ? null : v.toString();
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

/** Every pot's holdings. One pot that fails is logged and skipped (its previous rows stay); the others still refresh. */
export async function refreshHoldings(
  deps: { pots(): Promise<Address[]>; refresh(pot: Address): Promise<void> } = {
    pots: async () => (await db().select({ address: schema.pots.address }).from(schema.pots)).map((p) => getAddress(p.address)),
    refresh: refreshPotHoldings,
  },
) {
  let failed = 0;
  const pots = await deps.pots();
  for (const pot of pots) {
    try {
      await deps.refresh(pot);
    } catch (e) {
      failed++;
      logError(`cofer-keeper holdings ${pot}`, e);
    }
  }
  return { pots: pots.length, failed };
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
    if (r.accepted) await deps.alerts.send(r.accepted).catch((e) => logError("alerts", e));
    await checkAlert(continuityAlertKey(t.asset), r.problem, deps.alerts);
    out.push({ asset: t.symbol, problem: r.problem !== null });
  }
  return out;
}

/** Clears vote-failure alerts once the vote executed or ended (opened by the relayer). */
export async function clearVoteAlerts(
  deps: { open(): Promise<string[]>; proposal(id: string): Promise<{ status: string; deadline: number } | undefined>; alerts: AlertDeps; now(): number } = {
    open: async () => (await db().select({ key: schema.alerts.key }).from(schema.alerts).where(like(schema.alerts.key, "vote-failed:%"))).map((r) => r.key),
    proposal: (id) => db().query.proposals.findFirst({ where: eq(schema.proposals.id, id) }),
    alerts: alertDeps(),
    now: () => Math.floor(Date.now() / 1000),
  },
) {
  let cleared = 0;
  for (const key of await deps.open()) {
    const id = key.slice("vote-failed:".length);
    const why = voteAlertClears(await deps.proposal(id), deps.now());
    if (why && (await checkAlert(key, null, deps.alerts, why)) === "cleared") cleared++;
  }
  return cleared;
}

export const RELAYER_FUNDS_ALERT = "relayer-eth-low";

/** Alerts while the relayer's ETH is below RELAYER_MIN_ETH. A failed balance read is logged and changes nothing. */
export async function checkRelayerFunds(
  deps: { address(): string; balance(address: string): Promise<bigint>; min: bigint; alerts: AlertDeps } = {
    address: () => relayerClient().account.address, // public address only; the key never leaves the account object
    balance: (address) => publicClient().getBalance({ address: address as Address }),
    min: env().RELAYER_MIN_ETH,
    alerts: alertDeps(),
  },
) {
  const address = deps.address();
  let balance: bigint;
  try {
    balance = await deps.balance(address);
  } catch (e) {
    logError("cofer-keeper relayer funds", e);
    return null;
  }
  await checkAlert(RELAYER_FUNDS_ALERT, relayerFundsProblem(address, balance, deps.min), deps.alerts);
  return balance;
}

/** Alerts while the factory/fee-router roles differ from what is expected (see core/roles.ts). A failed read is logged and changes nothing. */
export async function checkRoles(
  deps: { read(): Promise<RoleState>; expected: { owner?: string; guardian?: string }; alerts: AlertDeps } = {
    read: async () => {
      const c = publicClient();
      const factory = factoryAddress();
      const router = (await c.readContract({ address: factory, abi: factoryAbi, functionName: "feeRouter" })) as Address;
      const [factoryOwner, factoryPendingOwner, guardian, routerOwner, routerPendingOwner] = await Promise.all([
        c.readContract({ address: factory, abi: factoryAbi, functionName: "owner" }),
        c.readContract({ address: factory, abi: factoryAbi, functionName: "pendingOwner" }),
        c.readContract({ address: factory, abi: factoryAbi, functionName: "guardian" }),
        c.readContract({ address: router, abi: feeRouterAbi, functionName: "owner" }),
        c.readContract({ address: router, abi: feeRouterAbi, functionName: "pendingOwner" }),
      ]);
      return { factoryOwner, factoryPendingOwner, guardian, routerOwner, routerPendingOwner } as RoleState;
    },
    expected: { owner: env().EXPECTED_OWNER, guardian: env().EXPECTED_GUARDIAN },
    alerts: alertDeps(),
  },
) {
  let s: RoleState;
  try {
    s = await deps.read();
  } catch (e) {
    logError("cofer-keeper roles", e);
    return null;
  }
  const problem = roleProblem(s, deps.expected);
  await checkAlert(ROLES_ALERT, problem, deps.alerts);
  return problem === null;
}

export { INDEXER_LAG_ALERT };

/** Alerts while the indexer is more than INDEXER_MAX_LAG_SEC behind. A failed chain read is logged and changes nothing. */
export async function checkIndexerLag(
  deps: { cursor(): Promise<bigint | null>; head(): Promise<bigint>; blockTime(n: bigint): Promise<number>; confirmations: number; alerts: AlertDeps } = {
    cursor: async () => (await db().query.cursors.findFirst({ where: eq(schema.cursors.name, CURSOR) }))?.block ?? null,
    head: () => publicClient().getBlockNumber(),
    blockTime: async (n) => Number((await publicClient().getBlock({ blockNumber: n })).timestamp),
    confirmations: env().CONFIRMATIONS,
    alerts: alertDeps(),
  },
) {
  const cursor = await deps.cursor(); // a database failure fails the job (seen by the job-failure alert)
  let target: bigint, targetTime: number, cursorTime: number | null;
  try {
    target = (await deps.head()) - BigInt(deps.confirmations);
    if (cursor !== null && cursor >= target) {
      await checkAlert(INDEXER_LAG_ALERT, null, deps.alerts);
      return 0;
    }
    [targetTime, cursorTime] = await Promise.all([deps.blockTime(target), cursor === null ? null : deps.blockTime(cursor)]);
  } catch (e) {
    logError("cofer-keeper indexer lag", e);
    return null;
  }
  await checkAlert(INDEXER_LAG_ALERT, indexerLagProblem({ cursor, target, cursorTime, targetTime }), deps.alerts);
  return cursorTime === null ? null : targetTime - cursorTime;
}

/**
 * Every 5 minutes: operational checks. Each one runs even if an earlier one failed; the job still
 * fails afterwards (with the first error), so a check that keeps failing is seen.
 */
export async function opsChecks(checks: Record<string, () => Promise<unknown>> = {
  voteAlertsCleared: clearVoteAlerts,
  relayerWei: async () => (await checkRelayerFunds())?.toString() ?? null,
  indexerLagSec: () => checkIndexerLag(),
  rolesAsExpected: () => checkRoles(),
}) {
  const out: Record<string, unknown> = {};
  let first: unknown;
  for (const [name, run] of Object.entries(checks)) {
    try {
      out[name] = await run();
    } catch (e) {
      first ??= e;
      out[name] = null;
    }
  }
  if (first !== undefined) throw first;
  return out;
}

export async function scheduleKeeper() {
  const q = queues().keeper;
  await q.upsertJobScheduler("expire", { every: 60_000 }, { name: "expire" });
  await q.upsertJobScheduler("sweep", { every: 30_000 }, { name: "sweep" });
  await q.upsertJobScheduler("stocks", { every: 3_600_000 }, { name: "stocks" });
  await q.upsertJobScheduler("holdings", { every: 300_000 }, { name: "holdings" });
  await q.upsertJobScheduler("feeds", { every: 900_000 }, { name: "feeds" });
  await q.upsertJobScheduler("ops", { every: 300_000 }, { name: "ops" });
  await q.upsertJobScheduler("health", { every: HEALTH_EVERY_MS }, { name: "health" });
}

export function startKeeper() {
  const w = startWorker(
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
        case "ops":
          return opsChecks();
        case "health":
          return healthPing();
        case "feeds":
          return { feeds: await feedHealth(), continuity: await multiplierContinuity() };
      }
    },
    { concurrency: 1 },
  );
  watchJobFailures(w);
  return w;
}
