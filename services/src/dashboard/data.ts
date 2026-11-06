/**
 * The dashboard's real data source: the indexer's tables (pots, members, proposals, signatures,
 * chain events, holdings) and, for prices, the factory's own valuation (CoferFactory.valueInUsdg),
 * read live and kept for PRICE_CACHE_MS so a page that polls does not hit the RPC each time.
 * Read-only: nothing here writes, except marking a one-time link used.
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getAddress, type Address, type PublicClient } from "viem";
import { db as getDb, schema, type DB } from "../db/client";
import { erc20Abi, factoryAbi, potAbi } from "../chain/clients";
import { errorKind } from "../core/errors";
import { INDEXER_LAG_ALERT } from "../core/indexerLag";
import { CURSOR } from "../indexer/indexer";
import type { DashboardDeps, PotListItem } from "./routes";
import { USDG_DECIMALS, type AssetMeta, type PotViewInput, type PricedHoldingRow, type ProposalStatus } from "./view";

export const PRICE_CACHE_MS = 15_000;
const EVENTS_READ = 200; // the view keeps the newest MAX_ACTIVITY of these

type Client = Pick<PublicClient, "readContract">;

/** A price the factory refuses (stale or bad feed) is null, "price paused"; a chain failure is thrown. */
async function pausedOrThrow(read: () => Promise<bigint>): Promise<bigint | null> {
  try {
    return await read();
  } catch (e) {
    if (errorKind(e) === "rpc") throw e;
    return null;
  }
}

export function priceReader(client: Client, factory: Address, nowMs: () => number = Date.now) {
  const cache = new Map<string, { at: number; v: bigint | null }>();
  return async (asset: Address, amount: bigint): Promise<bigint | null> => {
    const key = `${asset.toLowerCase()}:${amount}`;
    const hit = cache.get(key);
    if (hit && nowMs() - hit.at < PRICE_CACHE_MS) return hit.v;
    const v = amount === 0n ? 0n : await pausedOrThrow(() => client.readContract({ address: factory, abi: factoryAbi, functionName: "valueInUsdg", args: [asset, amount] }));
    if (cache.size > 2_000) cache.clear();
    cache.set(key, { at: nowMs(), v });
    return v;
  };
}

export function dashboardData(o: { db?: DB; client: PublicClient; factory: Address; usdg: Address; chainId: number; secret: string }): DashboardDeps {
  const d = () => o.db ?? getDb();
  const price = priceReader(o.client, o.factory);
  const tokenMeta = new Map<string, { symbol: string; decimals: number }>();

  async function metaFor(assets: string[]): Promise<Map<string, AssetMeta>> {
    const out = new Map<string, AssetMeta>();
    out.set(o.usdg.toLowerCase(), { symbol: "USDG", decimals: USDG_DECIMALS, isStock: false, multiplier: null });
    const wanted = [...new Set(assets.map((a) => getAddress(a)))].filter((a) => a.toLowerCase() !== o.usdg.toLowerCase());
    if (!wanted.length) return out;
    const rows = await d().select().from(schema.assets).where(inArray(schema.assets.address, wanted));
    for (const r of rows) out.set(r.address.toLowerCase(), { symbol: r.symbol, decimals: r.decimals, isStock: r.isStock, multiplier: r.currentMultiplier });
    for (const a of wanted) {
      if (out.has(a.toLowerCase())) continue;
      // not in the listing table (e.g. delisted): its own symbol and decimals, read once
      let m = tokenMeta.get(a.toLowerCase());
      if (!m) {
        const [symbol, decimals] = await Promise.all([
          o.client.readContract({ address: a, abi: erc20Abi, functionName: "symbol" }) as Promise<string>,
          o.client.readContract({ address: a, abi: erc20Abi, functionName: "decimals" }) as Promise<number>,
        ]);
        m = { symbol: String(symbol).slice(0, 16), decimals: Number(decimals) };
        tokenMeta.set(a.toLowerCase(), m);
      }
      out.set(a.toLowerCase(), { ...m, isStock: false, multiplier: null });
    }
    return out;
  }

  async function priced(holdings: (typeof schema.holdings.$inferSelect)[], meta: Map<string, AssetMeta>): Promise<PricedHoldingRow[]> {
    return Promise.all(
      holdings.map(async (h) => {
        const asset = getAddress(h.asset);
        const available = BigInt(h.rawBalance) - BigInt(h.reserved);
        const decimals = meta.get(asset.toLowerCase())?.decimals ?? 18;
        const [valueUsdg, unitPriceUsdg] = await Promise.all([price(asset, available > 0n ? available : 0n), price(asset, 10n ** BigInt(decimals))]);
        return { asset, rawBalance: h.rawBalance, reserved: h.reserved, updatedAt: h.updatedAt, valueUsdg, unitPriceUsdg };
      }),
    );
  }

  async function isActiveMember(pot: Address, member: Address): Promise<boolean> {
    const row = await d()
      .select({ a: schema.members.address })
      .from(schema.members)
      .where(and(eq(schema.members.pot, pot), sql`lower(${schema.members.address}) = ${member.toLowerCase()}`, eq(schema.members.active, true)))
      .limit(1);
    return row.length > 0;
  }

  return {
    secret: o.secret,
    chainId: o.chainId,

    async spendLink(l) {
      // one atomic statement: of two simultaneous requests with the same link, only one gets a row back
      const now = new Date();
      const rows = await d()
        .insert(schema.linkTokens)
        .values({ jti: l.jti, tgId: l.tg, purpose: l.purpose, usedAt: now, expiresAt: l.expiresAt })
        .onConflictDoUpdate({ target: schema.linkTokens.jti, set: { usedAt: now }, setWhere: isNull(schema.linkTokens.usedAt) })
        .returning({ jti: schema.linkTokens.jti });
      return rows.length > 0;
    },

    async keyOf(tg) {
      const u = await d().query.users.findFirst({ where: eq(schema.users.tgId, tg) });
      return u?.address ? getAddress(u.address) : null;
    },

    async potsOf(member) {
      const rows = await d()
        .select({ pot: schema.pots })
        .from(schema.members)
        .innerJoin(schema.pots, eq(schema.pots.address, schema.members.pot))
        .where(and(sql`lower(${schema.members.address}) = ${member.toLowerCase()}`, eq(schema.members.active, true)));
      const out: PotListItem[] = [];
      for (const { pot } of rows) {
        const [count] = await d()
          .select({ n: sql<number>`count(*)::int` })
          .from(schema.members)
          .where(and(eq(schema.members.pot, pot.address), eq(schema.members.active, true)));
        const hs = await d().select().from(schema.holdings).where(eq(schema.holdings.pot, pot.address));
        const meta = await metaFor(hs.map((h) => h.asset));
        const ps = await priced(hs, meta);
        const vals = ps.filter((h) => h.valueUsdg !== null).map((h) => h.valueUsdg!);
        const partial = vals.length < ps.length;
        out.push({
          address: pot.address,
          title: pot.title,
          members: count?.n ?? 0,
          totalUsdg: partial && vals.length === 0 ? null : vals.reduce((a, b) => a + b, 0n),
          partial,
        });
      }
      return out;
    },

    async potInput(potAddr, member, now): Promise<PotViewInput | null> {
      if (!(await isActiveMember(potAddr, member))) return null;
      const pot = await d().query.pots.findFirst({ where: eq(schema.pots.address, potAddr) });
      if (!pot) return null;

      const members = await d()
        .select({ address: schema.members.address, shares: schema.members.shares, allowance: schema.members.allowance, period: schema.members.period, username: schema.users.username })
        .from(schema.members)
        .leftJoin(schema.users, sql`lower(${schema.users.address}) = lower(${schema.members.address})`)
        .where(and(eq(schema.members.pot, potAddr), eq(schema.members.active, true)));

      const proposals = await d().select().from(schema.proposals).where(eq(schema.proposals.pot, potAddr)).orderBy(desc(schema.proposals.createdAt)).limit(50);
      const ids = proposals.map((p) => p.id);
      const signatures = ids.length
        ? await d().select({ proposalId: schema.signatures.proposalId, signer: schema.signatures.signer, revoked: schema.signatures.revoked }).from(schema.signatures).where(inArray(schema.signatures.proposalId, ids))
        : [];

      const hs = await d().select().from(schema.holdings).where(eq(schema.holdings.pot, potAddr));
      const events = await d()
        .select()
        .from(schema.chainEvents)
        .where(eq(schema.chainEvents.address, potAddr))
        .orderBy(desc(schema.chainEvents.block), desc(schema.chainEvents.logIndex))
        .limit(EVENTS_READ);
      const eventAssets: string[] = [];
      for (const e of events) {
        const a = e.args as Record<string, unknown>;
        for (const k of ["asset", "tokenIn", "tokenOut"]) if (typeof a[k] === "string") eventAssets.push(a[k] as string);
      }
      const meta = await metaFor([...hs.map((h) => h.asset), ...eventAssets]);
      const holdings = await priced(hs, meta);

      // the caller's own allowance, live from the pot; unreadable = shown from the indexer, without "left"
      let myAllowance: PotViewInput["myAllowance"] = null;
      try {
        const info = await o.client.readContract({ address: potAddr, abi: potAbi, functionName: "memberInfo", args: [member] });
        myAllowance = { allowance: info.allowance, period: Number(info.period), periodStart: Number(info.periodStart), spent: info.spent };
      } catch (e) {
        if (errorKind(e) !== "rpc") throw e;
      }

      const cursor = await d().query.cursors.findFirst({ where: eq(schema.cursors.name, CURSOR) });
      const lag = await d().query.alerts.findFirst({ where: eq(schema.alerts.key, INDEXER_LAG_ALERT) });

      return {
        chainId: o.chainId,
        usdg: o.usdg,
        me: member,
        now,
        pot: {
          address: pot.address,
          title: pot.title,
          threshold: pot.threshold,
          thresholdBps: pot.thresholdBps,
          guardDelay: pot.guardDelay,
          depositsOpen: pot.depositsOpen,
          totalShares: pot.totalShares,
          planPaidUntil: pot.planPaidUntil,
        },
        members,
        proposals: proposals.map((p) => ({
          id: p.id,
          kind: p.kind,
          summary: p.summary,
          status: p.status as ProposalStatus,
          queuedEta: p.queuedEta,
          txHash: p.txHash,
          createdAt: p.createdAt,
        })),
        signatures,
        holdings,
        assets: meta,
        events: events.map((e) => ({ txHash: e.txHash, logIndex: e.logIndex, block: e.block, name: e.name, args: e.args as Record<string, unknown>, at: e.at })),
        myAllowance,
        indexer: { block: cursor?.block ?? null, behind: !!lag || !cursor },
      };
    },
  };
}
