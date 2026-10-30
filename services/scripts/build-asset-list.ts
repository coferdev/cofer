#!/usr/bin/env bun
/**
 * Builds the multisig batch that lists Stock Tokens on CoferFactory.
 *  - addresses come ONLY from the issuer's public API (chainId 4663) -> no look-alike tokens
 *  - a stock the issuer marks as not tradable is skipped
 *  - each must have a Chainlink feed on RHC (8 dp, already includes the multiplier)
 *  - prints calldata for CoferFactory.listAsset(asset, feed, maxStaleness, isStock=true)
 *
 *   bun scripts/build-asset-list.ts TSLA NVDA SPY AAPL
 */
import { encodeFunctionData, type Address } from "viem";
import { fetchCanonicalStocks } from "../src/stocks/canonical";
import { FEEDS, STOCK_API } from "../src/chain/addresses";
import { coferFactoryAbi } from "../src/chain/abi";

const WEEKEND_STALENESS = 4 * 24 * 3600; // US market weekend + holiday; deposits/swaps revert beyond this

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
  rows.push({
    symbol: sym,
    asset: s.address,
    feed,
    data: encodeFunctionData({ abi: coferFactoryAbi, functionName: "listAsset", args: [s.address, feed, WEEKEND_STALENESS, true] }),
  });
}
console.log(JSON.stringify(rows, null, 2));
