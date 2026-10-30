/**
 * Uniswap v3 quotes for one pair across every fee tier, checked when a vote is built and never
 * stored (the best tier for a stock moves within minutes).
 *  - a tier is used only if the factory has a pool for it and the pool has liquidity in range
 *  - each QuoterV2 call is an eth_call with a gas cap: a badly priced pool can otherwise walk
 *    empty ticks for a very long time and stall the bot
 */
import { zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { RHC } from "./addresses";
import { encodeV3Path } from "../core/swap";
import { errorKind } from "../core/errors";
import { passesDepth } from "../core/depth";

/** 0.01%, 0.05%, 0.3%, 1%. */
export const FEE_TIERS = [100, 500, 3000, 10_000] as const;
/** A normal single-pool quote uses about 100k-150k gas. */
export const QUOTE_GAS = 500_000n;

const V3_FACTORY_ABI = [
  {
    type: "function",
    name: "getPool",
    stateMutability: "view",
    inputs: [{ type: "address" }, { type: "address" }, { type: "uint24" }],
    outputs: [{ type: "address" }],
  },
] as const;

const V3_POOL_ABI = [
  { type: "function", name: "liquidity", stateMutability: "view", inputs: [], outputs: [{ type: "uint128" }] },
] as const;

const QUOTER_V2_ABI = [
  {
    type: "function",
    name: "quoteExactInput",
    stateMutability: "nonpayable",
    inputs: [{ type: "bytes", name: "path" }, { type: "uint256", name: "amountIn" }],
    outputs: [
      { type: "uint256", name: "amountOut" },
      { type: "uint160[]", name: "sqrtPriceX96AfterList" },
      { type: "uint32[]", name: "initializedTicksCrossedList" },
      { type: "uint256", name: "gasEstimate" },
    ],
  },
] as const;

export type QuoteClient = Pick<PublicClient, "readContract" | "simulateContract">;

export type TierQuote =
  | { fee: number; status: "ok"; pool: Address; path: Hex; out: bigint }
  | { fee: number; status: "no-pool" }
  | { fee: number; status: "no-liquidity"; pool: Address }
  | { fee: number; status: "pool-failed"; error: unknown } // the pool reverted, e.g. ran out of the gas cap
  | { fee: number; status: "rpc-error"; error: unknown }; // could not ask the chain at all

export type OkQuote = Extract<TierQuote, { status: "ok" }>;

async function quoteTier(client: QuoteClient, tokenIn: Address, tokenOut: Address, amountIn: bigint, fee: number): Promise<TierQuote> {
  try {
    const pool = await client.readContract({ address: RHC.UNI_V3_FACTORY, abi: V3_FACTORY_ABI, functionName: "getPool", args: [tokenIn, tokenOut, fee] });
    if (pool === zeroAddress) return { fee, status: "no-pool" };
    const liquidity = await client.readContract({ address: pool, abi: V3_POOL_ABI, functionName: "liquidity" });
    if (liquidity === 0n) return { fee, status: "no-liquidity", pool };
    const path = encodeV3Path([tokenIn, tokenOut], [fee]);
    const { result } = await client.simulateContract({
      address: RHC.UNI_V3_QUOTER_V2,
      abi: QUOTER_V2_ABI,
      functionName: "quoteExactInput",
      args: [path, amountIn],
      gas: QUOTE_GAS,
    });
    return { fee, status: "ok", pool, path, out: result[0] };
  } catch (error) {
    return { fee, status: errorKind(error) === "revert" ? "pool-failed" : "rpc-error", error };
  }
}

/** One result per fee tier, in FEE_TIERS order. Never throws. */
export function quoteAllTiers(client: QuoteClient, tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<TierQuote[]> {
  return Promise.all(FEE_TIERS.map((fee) => quoteTier(client, tokenIn, tokenOut, amountIn, fee)));
}

/** True if any tier could not be asked at all: the result is then incomplete and must not be used. */
export function anyRpcError(quotes: TierQuote[]): boolean {
  return quotes.some((q) => q.status === "rpc-error");
}

/** The tier that pays the most, or null if none quoted. */
export function bestTier(quotes: TierQuote[]): OkQuote | null {
  let best: OkQuote | null = null;
  for (const q of quotes) if (q.status === "ok" && (!best || q.out > best.out)) best = q;
  return best;
}

/** Fee tiers whose quote passes the depth rule against `oracleOut` (same size as the quotes). */
export function deepTiers(quotes: TierQuote[], oracleOut: bigint): number[] {
  return quotes.filter((q): q is OkQuote => q.status === "ok" && passesDepth(q.out, oracleOut)).map((q) => q.fee);
}

export type TierChoice =
  | { kind: "ok"; quote: OkQuote }
  | { kind: "rpc-error" } // some tier could not be asked: never decide from partial results
  | { kind: "too-thin" } // pools quote, but none passes the depth rule
  | { kind: "no-pool" }; // nothing quotes at all

/**
 * For a vote: the best tier at the trade size, among tiers that pass the depth rule at the test
 * size. `depthQuotes`/`oracleDepthOut` are at the test size (the same values when sizes match).
 */
export function chooseTier(tradeQuotes: TierQuote[], depthQuotes: TierQuote[], oracleDepthOut: bigint): TierChoice {
  if (anyRpcError(tradeQuotes) || anyRpcError(depthQuotes)) return { kind: "rpc-error" };
  const deep = new Set(deepTiers(depthQuotes, oracleDepthOut));
  const best = bestTier(tradeQuotes.filter((q) => deep.has(q.fee)));
  if (best) return { kind: "ok", quote: best };
  return bestTier(tradeQuotes) ? { kind: "too-thin" } : { kind: "no-pool" };
}

/**
 * For listing: the stock needs a deep pool to buy from AND a deep pool to sell into, each at
 * DEPTH_TEST_USDG (they may be different tiers, as each vote picks its own tier).
 */
export function listingDepth(buyQuotes: TierQuote[], sellQuotes: TierQuote[], oracleBuyOut: bigint, oracleSellOut: bigint) {
  const rpcError = anyRpcError(buyQuotes) || anyRpcError(sellQuotes);
  const buyTiers = deepTiers(buyQuotes, oracleBuyOut);
  const sellTiers = deepTiers(sellQuotes, oracleSellOut);
  return { rpcError, buyTiers, sellTiers, ok: !rpcError && buyTiers.length > 0 && sellTiers.length > 0 };
}
