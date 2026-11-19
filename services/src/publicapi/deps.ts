/**
 * The public API's live data sources: the chain RPC (server side, never sent to a browser) and the indexer's
 * database. Read-only.
 */
import { eq } from "drizzle-orm";
import { getAddress, zeroAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { db, schema } from "../db/client";
import { aggregatorAbi, erc20Abi, factoryAbi, factoryAddress, feeRouterAbi, publicClient } from "../chain/clients";
import { signerRpcUrl } from "../web/page";
import { CURSOR } from "../indexer/indexer";
import type { Env } from "../env";
import type { PublicApiDeps } from "./router";
import type { FeedReading } from "./status";

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
      now: () => Math.floor(Date.now() / 1000),
    },
    ownership: {
      factory: factoryAddress(),
      feeRouter: async () => router ?? (router = await client.readContract({ address: factoryAddress(), abi: factoryAbi, functionName: "feeRouter" })),
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
        isPot: memo((a: Address) => client.readContract({ address: factoryAddress(), abi: factoryAbi, functionName: "isPot", args: [a] })),
        token: memo(async (a: Address) => {
          if (a.toLowerCase() === e.USDG_ADDRESS.toLowerCase()) return { symbol: "USDG", decimals: 6 };
          const row = await db().query.assets.findFirst({ where: eq(schema.assets.address, a.toLowerCase()) }).catch(() => undefined);
          if (row) return { symbol: row.symbol, decimals: row.decimals };
          try {
            const [symbol, decimals] = await Promise.all([client.readContract({ address: a, abi: erc20Abi, functionName: "symbol" }), client.readContract({ address: a, abi: erc20Abi, functionName: "decimals" })]);
            return { symbol: String(symbol).slice(0, 16), decimals: Number(decimals) };
          } catch {
            return null;
          }
        }),
      },
    },
  };
}
