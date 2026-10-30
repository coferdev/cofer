#!/usr/bin/env bun
/**
 * Builds the multisig batch that lists Stock Tokens on CoferFactory.
 *  - addresses come ONLY from the issuer's public API (chainId 4663) -> no look-alike tokens
 *  - a stock the issuer marks as not tradable is skipped
 *  - each must have a Chainlink feed on RHC (8 dp, already includes the multiplier)
 *  - each must have real Uniswap depth (src/core/depth.ts): a pool that buys DEPTH_TEST_USDG worth
 *    and a pool that sells DEPTH_TEST_USDG worth, both within DEPTH_MAX_GAP_BPS of the feed price
 *  - prints calldata for CoferFactory.listAsset(asset, feed, maxStaleness, isStock=true)
 * Reads the chain through RHC_RPC_URL (or the public RPC); the address is never printed.
 * Any RPC error stops the script with nothing printed (fail closed).
 *
 *   bun scripts/build-asset-list.ts TSLA NVDA SPY AAPL
 */
import { createPublicClient, encodeFunctionData, formatUnits, http, parseAbi, type Address } from "viem";
import { fetchCanonicalStocks } from "../src/stocks/canonical";
import { FEEDS, RHC, STOCK_API } from "../src/chain/addresses";
import { coferFactoryAbi } from "../src/chain/abi";
import { listingDepth, quoteAllTiers, type TierQuote } from "../src/chain/quotes";
import { DEPTH_MAX_GAP_BPS, DEPTH_TEST_USDG, gapBps } from "../src/core/depth";
import { quote, type FeedReading } from "../src/core/valuation";
import { logError } from "../src/core/errors";

const WEEKEND_STALENESS = 4 * 24 * 3600; // US market weekend + holiday; deposits/swaps revert beyond this
const USDG_STALENESS = 24 * 3600; // same as script/Deploy.s.sol
const PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";

const feedAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
]);

async function main() {
  const client = createPublicClient({ transport: http(process.env.RHC_RPC_URL ?? PUBLIC_RPC) });
  const chainId = await client.getChainId();
  if (chainId !== RHC.chainId) throw new Error(`RPC is chain ${chainId}, expected ${RHC.chainId}`);
  const now = Number((await client.getBlock()).timestamp);

  const readFeed = async (feed: Address): Promise<FeedReading> => {
    const [decimals, [, answer, , updatedAt]] = await Promise.all([
      client.readContract({ address: feed, abi: feedAbi, functionName: "decimals" }),
      client.readContract({ address: feed, abi: feedAbi, functionName: "latestRoundData" }),
    ]);
    return { answer, decimals, updatedAt: Number(updatedAt) };
  };

  const usdgFeed = await readFeed(FEEDS.USDG!);
  if (usdgFeed.answer <= 0n || now - usdgFeed.updatedAt > USDG_STALENESS) throw new Error("USDG feed is stale or bad; cannot judge depth");
  const usdgSide = { feed: usdgFeed, tokenDecimals: 6 };

  const wanted = process.argv.slice(2).map((s) => s.toUpperCase());
  const list = await fetchCanonicalStocks(process.env.STOCK_API_BASE ?? STOCK_API, 4663);
  const rows: { symbol: string; asset: Address; feed: Address; data: string }[] = [];
  for (const sym of wanted) {
    const s = list.find((x) => x.symbol.toUpperCase() === sym);
    const feed = FEEDS[sym];
    if (!s) {
      console.error(`skip ${sym}: not in the issuer's canonical list for chain 4663`);
      continue;
    }
    if (!s.tradable) {
      console.error(`skip ${sym}: the issuer lists it as not tradable (status ${s.status ?? "missing"})`);
      continue;
    }
    if (!feed) {
      console.error(`skip ${sym}: no Chainlink feed address configured (add it from the Chainlink RHC directory)`);
      continue;
    }

    const stockFeed = await readFeed(feed);
    if (stockFeed.answer <= 0n || now - stockFeed.updatedAt > WEEKEND_STALENESS) {
      console.error(`skip ${sym}: price feed is stale or bad, so depth cannot be judged`);
      continue;
    }
    const stockSide = { feed: stockFeed, tokenDecimals: s.decimals };
    const buyOracle = quote(DEPTH_TEST_USDG, usdgSide, stockSide); // stock for DEPTH_TEST_USDG
    const sellIn = buyOracle; // DEPTH_TEST_USDG worth of the stock
    const sellOracle = quote(sellIn, stockSide, usdgSide);
    const [buyQuotes, sellQuotes] = await Promise.all([
      quoteAllTiers(client, RHC.USDG, s.address, DEPTH_TEST_USDG),
      quoteAllTiers(client, s.address, RHC.USDG, sellIn),
    ]);
    const v = listingDepth(buyQuotes, sellQuotes, buyOracle, sellOracle);
    for (let i = 0; i < buyQuotes.length; i++) {
      console.error(`  ${sym} ${buyQuotes[i]!.fee / 10_000}%: buy ${describe(buyQuotes[i]!, buyOracle)} · sell ${describe(sellQuotes[i]!, sellOracle)}`);
    }
    if (v.rpcError) throw new Error(`could not reach the chain while checking ${sym}`);
    if (!v.ok) {
      const need = `${formatUnits(DEPTH_TEST_USDG, 6)} USDG within ${DEPTH_MAX_GAP_BPS / 100}%`;
      console.error(`skip ${sym}: no Uniswap pool deep enough to ${v.buyTiers.length ? "sell" : "buy"} ${need}`);
      continue;
    }
    rows.push({
      symbol: sym,
      asset: s.address,
      feed,
      data: encodeFunctionData({ abi: coferFactoryAbi, functionName: "listAsset", args: [s.address, feed, WEEKEND_STALENESS, true] }),
    });
  }
  console.log(JSON.stringify(rows, null, 2));
}

function describe(q: TierQuote, oracleOut: bigint): string {
  if (q.status !== "ok") return q.status;
  const g = gapBps(q.out, oracleOut);
  return `${(g / 100).toFixed(2)}% ${g >= -DEPTH_MAX_GAP_BPS ? "deep" : "thin"}`;
}

try {
  await main();
} catch (e) {
  logError("build-asset-list", e); // no URLs in the output
  console.error("stopped: nothing was printed for listing");
  process.exit(1);
}
