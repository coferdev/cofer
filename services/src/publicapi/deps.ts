/**
 * The public API's live data sources: the chain RPC (server side, never sent to a browser) and the indexer's
 * database. Read-only.
 */
import { eq } from "drizzle-orm";
import { getAddress, zeroAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { db, schema } from "../db/client";
import { aggregatorAbi, factoryAbi, factoryAddress, publicClient } from "../chain/clients";
import { CURSOR } from "../indexer/indexer";
import type { Env } from "../env";
import type { PublicApiDeps } from "./router";
import type { FeedReading } from "./status";

export function livePublicApiDeps(e: Env): PublicApiDeps {
  const client = publicClient();
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
  };
}
