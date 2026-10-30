#!/usr/bin/env bun
/**
 * Runs contracts/test/fork/SwapFork.t.sol on a LOCAL fork of Robinhood Chain mainnet (4663).
 * Forge only reads chain state over RPC; every transaction happens in the local copy. Nothing is
 * sent to the real chain and no key is used.
 *  - Stock Token addresses come ONLY from the issuer's public API (chainId 4663, fail closed)
 *  - USDG, Chainlink feeds and Uniswap addresses come from src/chain/addresses.ts
 *  - stops before forge if the chain id is wrong, a stock is missing or not tradable, a feed is
 *    not configured, names a different asset, or is already older than the factory would accept
 *
 *   bun scripts/fork-swap-test.ts             # TSLA and NVDA
 *   bun scripts/fork-swap-test.ts SPY AAPL
 *
 * FORK_RPC_URL overrides the public RPC; FORK_BLOCK pins a block (default: latest).
 */
import { createPublicClient, getAddress, http, parseAbi, type Address } from "viem";
import { fetchCanonicalStocks } from "../src/stocks/canonical";
import { FEEDS, RHC, STOCK_API } from "../src/chain/addresses";

const PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";
const rpc = process.env.FORK_RPC_URL ?? PUBLIC_RPC;
// Same limits as script/Deploy.s.sol (USDG) and scripts/build-asset-list.ts (stocks).
const USDG_MAX_AGE = 24 * 3600;
const STOCK_MAX_AGE = 4 * 24 * 3600;

const feedAbi = parseAbi([
  "function description() view returns (string)",
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
]);

function stop(msg: string): never {
  console.error(`fork test not started: ${msg}`);
  process.exit(1);
}

const client = createPublicClient({ transport: http(rpc) });
const chainId = await client.getChainId();
if (chainId !== RHC.chainId) stop(`RPC is chain ${chainId}, expected ${RHC.chainId}`);
const blockNumber = process.env.FORK_BLOCK ? BigInt(process.env.FORK_BLOCK) : await client.getBlockNumber();
const block = await client.getBlock({ blockNumber });
console.log(`RPC: ${rpc === PUBLIC_RPC ? "public mainnet RPC" : "FORK_RPC_URL"} · fork block ${blockNumber} (${new Date(Number(block.timestamp) * 1000).toISOString()})`);

/** The feed must name this asset ("RHTSLA / USD", "Robinhood AAPL / USD", "USDG / USD") and be fresh enough. */
async function checkFeed(symbol: string, feed: Address, maxAge: number) {
  const desc = await client.readContract({ address: feed, abi: feedAbi, functionName: "description", blockNumber });
  const base = desc.split("/")[0]!.trim().toUpperCase();
  if (![symbol, `RH${symbol}`, `ROBINHOOD ${symbol}`].includes(base)) stop(`feed ${feed} is "${desc}", not ${symbol}`);
  const [, answer, , updatedAt] = await client.readContract({ address: feed, abi: feedAbi, functionName: "latestRoundData", blockNumber });
  const age = Number(block.timestamp - updatedAt);
  if (answer <= 0n) stop(`${symbol} feed answer is ${answer}`);
  if (age > maxAge) stop(`${symbol} feed is ${(age / 3600).toFixed(1)}h old at this block (limit ${maxAge / 3600}h); swaps would revert as stale`);
  console.log(`${symbol} feed "${desc}" updated ${(age / 3600).toFixed(1)}h before the fork block`);
}

const wanted = (process.argv.length > 2 ? process.argv.slice(2) : ["TSLA", "NVDA"]).map((s) => s.toUpperCase());
// Issuer API only (no STOCK_API_BASE override here): the fork test must use canonical addresses.
const list = await fetchCanonicalStocks(STOCK_API, RHC.chainId);
if (list.length === 0) stop("the issuer API returned no Stock Tokens for chain 4663");

await checkFeed("USDG", FEEDS.USDG!, USDG_MAX_AGE);
const stocks: { symbol: string; address: Address; feed: Address }[] = [];
for (const sym of wanted) {
  const s = list.find((x) => x.symbol.toUpperCase() === sym);
  if (!s) stop(`${sym} is not in the issuer's canonical list for chain 4663`);
  if (!s.tradable) stop(`${sym} is not tradable (status ${s.status ?? "missing"})`);
  const feed = FEEDS[sym];
  if (!feed) stop(`${sym} has no Chainlink feed in src/chain/addresses.ts`);
  if (!(await client.getCode({ address: s.address, blockNumber }))) stop(`${sym} has no code at ${s.address}`);
  await checkFeed(sym, feed, STOCK_MAX_AGE);
  stocks.push({ symbol: sym, address: getAddress(s.address), feed });
}

const contractsDir = new URL("../../contracts", import.meta.url).pathname;
let failed = 0;
for (const s of stocks) {
  console.log(`\n=== ${s.symbol} ${s.address} ===`);
  const run = Bun.spawnSync(
    ["forge", "test", "--match-path", "test/fork/SwapFork.t.sol", "--fork-url", rpc, "--fork-block-number", String(blockNumber), "-vv"],
    {
      cwd: contractsDir,
      // minimal environment: forge gets the addresses it needs and nothing from .env
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        FORK_USDG: RHC.USDG,
        FORK_USDG_FEED: FEEDS.USDG!,
        FORK_STOCK: s.address,
        FORK_STOCK_FEED: s.feed,
        FORK_ROUTER: RHC.UNI_V3_SWAP_ROUTER_02,
        FORK_QUOTER: RHC.UNI_V3_QUOTER_V2,
        FORK_V3_FACTORY: RHC.UNI_V3_FACTORY,
      },
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  if (run.exitCode !== 0) failed++;
}
if (failed) {
  console.error(`\nfork test failed for ${failed} of ${stocks.length} stock(s)`);
  process.exit(1);
}
console.log(`\nfork test passed for ${stocks.map((s) => s.symbol).join(", ")} at block ${blockNumber}`);
