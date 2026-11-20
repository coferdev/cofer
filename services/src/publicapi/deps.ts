/**
 * The public API's live data sources: the chain RPC (server side, never sent to a browser) and the indexer's
 * database. Read-only.
 */
import { and, asc, count, desc, eq, gt, gte, inArray, lte, or, sql } from "drizzle-orm";
import { getAddress, zeroAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { db, schema } from "../db/client";
import { aggregatorAbi, erc20Abi, factoryAbi, factoryAddress, feeRouterAbi, potAbi, publicClient } from "../chain/clients";
import { signerRpcUrl } from "../web/page";
import { typedData } from "../core/proposal";
import { daysLeft, RUNWAY_DAYS } from "../core/relayerRunway";
import { readFileSync } from "node:fs";
import { CURSOR } from "../indexer/indexer";
import type { Env } from "../env";
import type { PublicApiDeps } from "./router";
import type { FeedReading } from "./status";

function readChangelog(): string {
  try {
    return readFileSync(new URL("../../../CHANGELOG.md", import.meta.url), "utf8");
  } catch {
    return ""; // no CHANGELOG.md in this folder: the feeds are empty, nothing else changes
  }
}

/** Days of gas left: the balance against the relayer spend ledger's last RUNWAY_DAYS UTC days. */
export async function relayerRunway(_relayer: Address, balance: bigint, nowSec = Math.floor(Date.now() / 1000)): Promise<number | null> {
  const days = Array.from({ length: RUNWAY_DAYS }, (_, i) => new Date((nowSec - (i + 1) * 86_400) * 1000).toISOString().slice(0, 10));
  const rows = await db()
    .select({ day: schema.relayerSpend.day, cost: sql<string>`sum(${schema.relayerSpend.costWei})::text` })
    .from(schema.relayerSpend)
    .where(inArray(schema.relayerSpend.day, days))
    .groupBy(schema.relayerSpend.day);
  return daysLeft(balance, rows.map((r) => BigInt(r.cost)));
}

/** Remembers each answer for an address (contracts' identities and token details do not change). */
function memo<T>(f: (a: Address) => Promise<T>, max = 5000): (a: Address) => Promise<T> {
  const m = new Map<string, Promise<T>>();
  return (a) => {
    const k = a.toLowerCase();
    let p = m.get(k);
    if (!p) {
      p = f(a).catch((err) => {
        m.delete(k); // a failed read is tried again next time
        throw err;
      });
      m.set(k, p);
      if (m.size > max) m.delete(m.keys().next().value!);
    }
    return p;
  };
}

export function livePublicApiDeps(e: Env): PublicApiDeps {
  const client = publicClient();
  let router: Address | undefined;
  // the factory's fee router is fixed at deploy; read once (until then, a value that matches no log)
  void client.readContract({ address: factoryAddress(), abi: factoryAbi, functionName: "feeRouter" }).then((r) => (router = r)).catch(() => {});
  const feeRouter = () => router ?? ("0x0000000000000000000000000000000000000000" as Address);
  const feeRouterNow = async () => router ?? (router = await client.readContract({ address: factoryAddress(), abi: factoryAbi, functionName: "feeRouter" }));
  const isPotMemo = memo((a: Address) => client.readContract({ address: factoryAddress(), abi: factoryAbi, functionName: "isPot", args: [a] }));
  /** A token's symbol and decimals: USDG, then the listed assets table, then the token itself; kept once read. */
  const tokenInfo = memo(async (a: Address) => {
    if (a.toLowerCase() === e.USDG_ADDRESS.toLowerCase()) return { symbol: "USDG", decimals: 6 };
    const row = await db().query.assets.findFirst({ where: eq(schema.assets.address, getAddress(a)) }).catch(() => undefined);
    if (row) return { symbol: row.symbol, decimals: row.decimals };
    try {
      const [symbol, decimals] = await Promise.all([client.readContract({ address: a, abi: erc20Abi, functionName: "symbol" }), client.readContract({ address: a, abi: erc20Abi, functionName: "decimals" })]);
      return { symbol: String(symbol).slice(0, 16), decimals: Number(decimals) };
    } catch {
      return null;
    }
  });
  const relayer = privateKeyToAccount(e.RELAYER_PRIVATE_KEY as `0x${string}`).address;
  return {
    chainId: e.CHAIN_ID,
    status: {
      chainId: e.CHAIN_ID,
      confirmations: e.CONFIRMATIONS,
      head: () => client.getBlockNumber(),
      blockTime: async (n) => Number((await client.getBlock({ blockNumber: n })).timestamp),
      cursor: async () => (await db().query.cursors.findFirst({ where: eq(schema.cursors.name, CURSOR) }))?.block ?? null,
      async feeds() {
        const listed = await db().select().from(schema.assets).where(eq(schema.assets.listedOnChain, true));
        const targets: { symbol: string; asset: Address }[] = [{ symbol: "USDG", asset: e.USDG_ADDRESS as Address }, ...listed.map((a) => ({ symbol: a.symbol, asset: getAddress(a.address) }))];
        const out: FeedReading[] = [];
        for (const t of targets) {
          const info = await client.readContract({ address: factoryAddress(), abi: factoryAbi, functionName: "assetInfo", args: [t.asset] });
          if (!info.listed || info.feed === zeroAddress) continue;
          const r = await client.readContract({ address: info.feed, abi: aggregatorAbi, functionName: "latestRoundData" });
          out.push({ symbol: t.symbol, asset: t.asset, answer: r[1], updatedAt: Number(r[3]), maxStaleness: info.maxStaleness });
        }
        return out;
      },
      relayerHasGas: async () => (await client.getBalance({ address: relayer })) >= e.RELAYER_MIN_ETH,
      relayerDaysLeft: async () => relayerRunway(relayer, await client.getBalance({ address: relayer })),
      now: () => Math.floor(Date.now() / 1000),
    },
    // this release's CHANGELOG.md (services/src/publicapi/deps.ts is three folders below the repo's top)
    changelog: { text: readChangelog(), baseUrl: e.PUBLIC_URL },
    pots: {
      isPot: (a) => client.readContract({ address: factoryAddress(), abi: factoryAbi, functionName: "isPot", args: [a] }),
      read: (pot, fn, args) => client.readContract({ address: pot, abi: potAbi, functionName: fn as never, args: args as never }),
      balanceOf: (t, h) => client.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [h] }),
      token: (a) => tokenInfo(a),
      planPaidUntil: async (pot) => BigInt(await client.readContract({ address: await feeRouterNow(), abi: feeRouterAbi, functionName: "planPaidUntil", args: [pot] })),
      // only the created block is read from the pots table: never its Telegram columns
      createdBlock: async (pot) => (await db().select({ b: schema.pots.createdBlock }).from(schema.pots).where(eq(schema.pots.address, pot)).limit(1))[0]?.b ?? null,
    },
    members: {
      // only address, active and shares from the members table; no Telegram data exists there or is joined in
      members: (pot, after, limit) =>
        db()
          .select({ address: schema.members.address, active: schema.members.active, shares: schema.members.shares })
          .from(schema.members)
          .where(after ? and(eq(schema.members.pot, pot), gt(sql`lower(${schema.members.address})`, after.toLowerCase())) : eq(schema.members.pot, pot))
          .orderBy(asc(sql`lower(${schema.members.address})`))
          .limit(limit),
      async joinBlocks(pot, members) {
        const out = new Map<string, bigint>();
        if (!members.length) return out;
        const rows = await db()
          .select({ block: schema.chainEvents.block, member: sql<string>`${schema.chainEvents.args}->>'member'` })
          .from(schema.chainEvents)
          .where(and(eq(schema.chainEvents.address, pot), eq(schema.chainEvents.name, "MemberAdded"), inArray(sql`lower(${schema.chainEvents.args}->>'member')`, members.map((m) => m.toLowerCase()))));
        for (const r of rows) {
          const k = r.member.toLowerCase();
          if (!out.has(k) || out.get(k)! < r.block) out.set(k, r.block);
        }
        return out;
      },
    },
    votes: {
      usdg: e.USDG_ADDRESS as Address,
      token: (a) => tokenInfo(a),
      // only these columns: never the proposer, the chat message or the stored summary (which can hold usernames)
      botVotes: (pot, statuses, limit) =>
        db()
          .select({ id: schema.proposals.id, kind: schema.proposals.kind, data: schema.proposals.data, status: schema.proposals.status, deadline: schema.proposals.deadline, queuedEta: schema.proposals.queuedEta, txHash: schema.proposals.txHash, createdAt: schema.proposals.createdAt })
          .from(schema.proposals)
          .where(statuses ? and(eq(schema.proposals.pot, pot), inArray(schema.proposals.status, statuses as (typeof schema.proposals.status.enumValues)[number][])) : eq(schema.proposals.pot, pot))
          .orderBy(desc(schema.proposals.createdAt))
          .limit(limit),
      botVoteIds: async (pot) => new Set((await db().select({ id: schema.proposals.id }).from(schema.proposals).where(eq(schema.proposals.pot, pot))).map((r) => r.id)),
      async approvals(ids) {
        if (!ids.length) return new Map();
        const rows = await db()
          .select({ id: schema.signatures.proposalId, n: count() })
          .from(schema.signatures)
          .where(and(inArray(schema.signatures.proposalId, ids), eq(schema.signatures.revoked, false)))
          .groupBy(schema.signatures.proposalId);
        return new Map(rows.map((r) => [r.id, Number(r.n)]));
      },
      async voteEvents(pot) {
        const rows = await db()
          .select({ name: schema.chainEvents.name, args: schema.chainEvents.args, txHash: schema.chainEvents.txHash, block: schema.chainEvents.block })
          .from(schema.chainEvents)
          .where(and(eq(schema.chainEvents.address, pot), inArray(schema.chainEvents.name, ["ProposalQueued", "ProposalExecuted"])));
        return rows.map((r) => {
          const a = r.args as { digest: string; kind: string | number; eta?: string | number };
          return { name: r.name as "ProposalQueued" | "ProposalExecuted", digest: a.digest, kind: Number(a.kind), eta: a.eta === undefined ? null : Number(a.eta), txHash: r.txHash, block: r.block };
        });
      },
    },
    timeline: {
      explain: { usdg: e.USDG_ADDRESS as Address, token: (a) => tokenInfo(a) },
      events: async (pot, after, limit) =>
        (
          await db()
            .select({ block: schema.chainEvents.block, logIndex: schema.chainEvents.logIndex, txHash: schema.chainEvents.txHash, name: schema.chainEvents.name, args: schema.chainEvents.args })
            .from(schema.chainEvents)
            .where(
              after
                ? and(eq(schema.chainEvents.address, pot), or(gt(schema.chainEvents.block, after.block), and(eq(schema.chainEvents.block, after.block), gt(schema.chainEvents.logIndex, after.logIndex))))
                : eq(schema.chainEvents.address, pot),
            )
            .orderBy(asc(schema.chainEvents.block), asc(schema.chainEvents.logIndex))
            .limit(limit)
        ).map((r) => ({ ...r, args: r.args as Record<string, unknown> })),
    },
    receipts: {
      chainId: e.CHAIN_ID,
      usdg: e.USDG_ADDRESS as Address,
      rpcUrl: signerRpcUrl(e),
      isPot: isPotMemo,
      token: (a) => tokenInfo(a),
      receipt: (hash) => client.getTransactionReceipt({ hash }).catch((err: unknown) => (err instanceof Error && err.name === "TransactionReceiptNotFoundError" ? null : Promise.reject(err))),
    },
    voteReceipts: {
      chainId: e.CHAIN_ID,
      rpcUrl: signerRpcUrl(e),
      // the vote's own fields only: never the proposer, the chat message or the stored summary
      vote: async (digest) =>
        (
          await db()
            .select({ pot: schema.proposals.pot, kind: schema.proposals.kind, data: schema.proposals.data, nonce: schema.proposals.nonce, epoch: schema.proposals.epoch, deadline: schema.proposals.deadline, status: schema.proposals.status, txHash: schema.proposals.txHash })
            .from(schema.proposals)
            .where(eq(sql`lower(${schema.proposals.id})`, digest.toLowerCase()))
            .limit(1)
        )[0] ?? null,
      approvals: (digest) => db().select({ signer: schema.signatures.signer, signature: schema.signatures.signature, revoked: schema.signatures.revoked }).from(schema.signatures).where(eq(sql`lower(${schema.signatures.proposalId})`, digest.toLowerCase())),
      verify: (signer, env, signature) => client.verifyTypedData({ address: signer, signature, ...typedData(env) }),
    },
    keyGroups: {
      groupsOf: (member) =>
        db()
          .select({ pot: schema.members.pot, shares: schema.members.shares })
          .from(schema.members)
          .where(and(eq(sql`lower(${schema.members.address})`, member.toLowerCase()), eq(schema.members.active, true))),
      async joinBlocksIn(member, pots) {
        const out = new Map<string, bigint>();
        if (!pots.length) return out;
        const rows = await db()
          .select({ pot: schema.chainEvents.address, block: schema.chainEvents.block })
          .from(schema.chainEvents)
          .where(and(inArray(schema.chainEvents.address, pots), eq(schema.chainEvents.name, "MemberAdded"), eq(sql`lower(${schema.chainEvents.args}->>'member')`, member.toLowerCase())));
        for (const r of rows) {
          const k = r.pot.toLowerCase();
          if (!out.has(k) || out.get(k)! < r.block) out.set(k, r.block);
        }
        return out;
      },
    },
    setAsides: {
      rpcUrl: signerRpcUrl(e),
      token: (a) => tokenInfo(a),
      rowsFor: async (account) =>
        (
          await db()
            .select({ pot: schema.setAsides.pot, asset: schema.setAsides.asset, setAside: schema.setAsides.setAside, claimed: schema.setAsides.claimed, lastBlock: schema.setAsides.lastBlock })
            .from(schema.setAsides)
            .where(eq(sql`lower(${schema.setAsides.account})`, account.toLowerCase()))
        ).map((r) => ({ ...r, setAside: String(r.setAside), claimed: String(r.claimed) })),
    },
    admin: {
      token: (a) => tokenInfo(a),
      now: () => Math.floor(Date.now() / 1000),
      async rows(recent) {
        const t = schema.pendingAdminChanges;
        const queued = await db().select().from(t).where(eq(t.state, "queued"));
        const done = await db().select().from(t).where(sql`${t.state} <> 'queued'`).orderBy(desc(t.resolvedBlock)).limit(recent);
        return [...queued, ...done];
      },
    },
    holdings: {
      token: (a) => tokenInfo(a),
      now: () => Math.floor(Date.now() / 1000),
      rows: async (pot, from, to) => {
        const t = schema.holdingsDaily;
        const rows = await db().select({ asset: t.asset, day: t.day, block: t.block, blockTime: t.blockTime, rawBalance: t.rawBalance }).from(t).where(and(eq(t.pot, pot), gte(t.day, from), lte(t.day, to)));
        return rows.map((r) => ({ ...r, rawBalance: String(r.rawBalance) }));
      },
    },
    snapshotProof: {
      head: () => client.getBlockNumber(),
      confirmations: e.CONFIRMATIONS,
      heldAt: (pot, block) => client.readContract({ address: pot, abi: potAbi, functionName: "heldAssets", blockNumber: block }),
      balanceAt: (t, h, block) => client.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [h], blockNumber: block }),
      reservedAt: (pot, t, block) => client.readContract({ address: pot, abi: potAbi, functionName: "reserved", args: [t], blockNumber: block }),
      token: (a) => tokenInfo(a),
      rpcUrl: signerRpcUrl(e),
    },
    fees: {
      token: (a) => tokenInfo(a),
      rows: async (pot, after, limit) => {
        const t = schema.fees;
        const li = sql<number>`split_part(${t.id}, ':', 2)::int`;
        const rows = await db()
          .select({ id: t.id, kind: t.kind, asset: t.asset, amount: t.amount, months: t.months, block: t.block, tx: t.tx })
          .from(t)
          .where(after ? and(eq(t.pot, pot), or(gt(t.block, after.block), and(eq(t.block, after.block), sql`${li} > ${after.logIndex}`))) : eq(t.pot, pot))
          .orderBy(asc(t.block), asc(li))
          .limit(limit);
        return rows.map((r) => ({ ...r, amount: String(r.amount) }));
      },
    },
    potFeeds: {
      baseUrl: e.PUBLIC_URL,
      explain: { usdg: e.USDG_ADDRESS as Address, token: (a) => tokenInfo(a) },
      blockTime: async (n) => Number((await client.getBlock({ blockNumber: n })).timestamp),
      latest: async (pot, names, limit) =>
        (
          await db()
            .select({ block: schema.chainEvents.block, logIndex: schema.chainEvents.logIndex, txHash: schema.chainEvents.txHash, name: schema.chainEvents.name, args: schema.chainEvents.args })
            .from(schema.chainEvents)
            .where(and(eq(schema.chainEvents.address, pot), inArray(schema.chainEvents.name, names)))
            .orderBy(desc(schema.chainEvents.block), desc(schema.chainEvents.logIndex))
            .limit(limit)
        ).map((r) => ({ ...r, args: r.args as Record<string, unknown> })),
    },
    ownership: {
      factory: factoryAddress(),
      feeRouter: feeRouterNow,
      rpcUrl: signerRpcUrl(e),
      readFactory: (fn) => client.readContract({ address: factoryAddress(), abi: factoryAbi, functionName: fn as never }),
      readRouter: (r, fn, args) => client.readContract({ address: r, abi: feeRouterAbi, functionName: fn as never, args: args as never }),
    },
    tx: {
      receipt: (hash) => client.getTransactionReceipt({ hash }).catch((err: unknown) => (err instanceof Error && err.name === "TransactionReceiptNotFoundError" ? null : Promise.reject(err))),
      blockTime: async (n) => Number((await client.getBlock({ blockNumber: n })).timestamp),
      explain: {
        factory: factoryAddress(),
        get feeRouter() {
          return feeRouter();
        },
        usdg: e.USDG_ADDRESS as Address,
        isPot: isPotMemo,
        token: (a: Address) => tokenInfo(a),
      },
    },
  };
}
