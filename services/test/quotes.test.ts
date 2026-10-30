import { describe, expect, test } from "bun:test";
import { ExecutionRevertedError, HttpRequestError, zeroAddress, type Address } from "viem";
import { anyRpcError, bestTier, FEE_TIERS, QUOTE_GAS, quoteAllTiers, type QuoteClient } from "../src/chain/quotes";
import { encodeV3Path } from "../src/core/swap";

const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
const STOCK = "0x322F0929c4625eD5bAd873c95208D54E1c003b2d" as Address;
const pool = (fee: number) => `0x${fee.toString(16).padStart(40, "0")}` as Address;

type Tier = { pool?: boolean; liquidity?: bigint; out?: bigint; getPoolThrows?: boolean; quoteThrows?: boolean };

/** Fake chain: per fee tier, whether a pool exists, its liquidity, and what QuoterV2 returns. */
function fakeClient(tiers: Record<number, Tier>) {
  const quoteGas: bigint[] = [];
  const client = {
    readContract: async (a: { functionName: string; args?: unknown[]; address: Address }) => {
      if (a.functionName === "getPool") {
        const t = tiers[a.args![2] as number] ?? {};
        if (t.getPoolThrows) throw new HttpRequestError({ url: "https://rpc.example/KEY", details: "fetch failed" });
        return t.pool ? pool(a.args![2] as number) : zeroAddress;
      }
      if (a.functionName === "liquidity") return tiers[Number(BigInt(a.address))]?.liquidity ?? 0n;
      throw new Error(`unexpected read ${a.functionName}`);
    },
    simulateContract: async (a: { args: [string, bigint]; gas?: bigint }) => {
      quoteGas.push(a.gas!);
      const fee = parseInt(a.args[0].slice(42, 48), 16);
      const t = tiers[fee]!;
      if (t.quoteThrows) throw new ExecutionRevertedError({ message: "execution reverted: Unexpected error" });
      return { result: [t.out!, [], [], 0n] };
    },
  };
  return { client: client as unknown as QuoteClient, quoteGas };
}

describe("per-stock fee tiers", () => {
  test("tries all four tiers, including 0.01%, and picks the best quote", async () => {
    expect([...FEE_TIERS]).toEqual([100, 500, 3000, 10_000]);
    const { client } = fakeClient({
      100: { pool: true, liquidity: 1n, out: 900n },
      500: { pool: true, liquidity: 1n, out: 1_000n },
      3000: { pool: true, liquidity: 1n, out: 1_200n },
      10_000: { pool: true, liquidity: 1n, out: 1_100n },
    });
    const quotes = await quoteAllTiers(client, USDG, STOCK, 100n);
    expect(quotes.map((q) => q.fee)).toEqual([100, 500, 3000, 10_000]);
    const best = bestTier(quotes)!;
    expect(best.fee).toBe(3000);
    expect(best.out).toBe(1_200n);
    expect(best.path).toBe(encodeV3Path([USDG, STOCK], [3000]));
  });

  test("0.01% wins when it pays the most", async () => {
    const { client } = fakeClient({ 100: { pool: true, liquidity: 1n, out: 2_000n }, 500: { pool: true, liquidity: 1n, out: 1_000n } });
    expect(bestTier(await quoteAllTiers(client, USDG, STOCK, 100n))!.fee).toBe(100);
  });

  test("tiers with no pool or no liquidity are skipped without quoting", async () => {
    const { client, quoteGas } = fakeClient({ 100: { pool: false }, 500: { pool: true, liquidity: 0n }, 3000: { pool: true, liquidity: 5n, out: 7n } });
    const quotes = await quoteAllTiers(client, USDG, STOCK, 100n);
    expect(quotes.map((q) => q.status)).toEqual(["no-pool", "no-liquidity", "ok", "no-pool"]);
    expect(quoteGas.length).toBe(1);
  });

  test("every quote carries the gas cap", async () => {
    const { client, quoteGas } = fakeClient({
      100: { pool: true, liquidity: 1n, out: 1n },
      500: { pool: true, liquidity: 1n, out: 1n },
      3000: { pool: true, liquidity: 1n, out: 1n },
      10_000: { pool: true, liquidity: 1n, out: 1n },
    });
    await quoteAllTiers(client, USDG, STOCK, 100n);
    expect(QUOTE_GAS).toBe(500_000n);
    expect(quoteGas).toEqual([QUOTE_GAS, QUOTE_GAS, QUOTE_GAS, QUOTE_GAS]);
  });

  test("a pool that reverts is a pool failure; a tier the RPC could not answer is an RPC error", async () => {
    const { client } = fakeClient({
      100: { pool: true, liquidity: 1n, quoteThrows: true }, // e.g. NVDA's badly priced 0.01% pool
      500: { pool: true, liquidity: 1n, out: 480n },
      3000: { getPoolThrows: true },
    });
    const quotes = await quoteAllTiers(client, USDG, STOCK, 100n);
    expect(quotes.map((q) => q.status)).toEqual(["pool-failed", "ok", "rpc-error", "no-pool"]);
    expect(anyRpcError(quotes)).toBe(true); // the bot refuses: never propose from partial results
    expect(bestTier(quotes)!.fee).toBe(500);
  });

  test("no usable tier gives null", async () => {
    const { client } = fakeClient({ 100: { pool: true, liquidity: 1n, quoteThrows: true } });
    expect(bestTier(await quoteAllTiers(client, USDG, STOCK, 100n))).toBeNull();
  });
});

describe("RPC errors are not read as no pool", () => {
  test("a broken pool alone does not count as an RPC error", async () => {
    const { client } = fakeClient({ 100: { pool: true, liquidity: 1n, quoteThrows: true }, 500: { pool: true, liquidity: 1n, out: 480n } });
    const quotes = await quoteAllTiers(client, USDG, STOCK, 100n);
    expect(anyRpcError(quotes)).toBe(false);
    expect(bestTier(quotes)!.fee).toBe(500);
  });
});
