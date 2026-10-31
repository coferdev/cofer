import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ContractFunctionRevertedError, encodeErrorResult, HttpRequestError, type Address } from "viem";
import { coferFactoryAbi } from "../src/chain/abi";
import { shownQuantity, valueInUsdg } from "../src/core/valuation";
import { refreshHoldings, valueOrPaused } from "../src/keeper/keeper";

const E18 = 10n ** 18n;

describe("/pot quantity: raw x multiplier, value never changes", () => {
  test("after a 2-for-1 split, 1 raw TSLA shows as 2; the value stays raw x feed", () => {
    expect(shownQuantity(E18, 18, "1.000000000000000000")).toBe("1");
    expect(shownQuantity(E18, 18, "2.000000000000000000")).toBe("2");
    const feed = { answer: 500_00000000n, decimals: 8, updatedAt: 0 }; // the feed already includes the multiplier
    const usdgFeed = { answer: 1_00000000n, decimals: 8, updatedAt: 0 };
    expect(valueInUsdg({ rawBalance: E18, tokenDecimals: 18, feed, uiMultiplier: 2n * E18 }, usdgFeed)).toBe(500_000_000n); // 500 USDG, not 1,000
  });

  test("dividend-sized multipliers: cut to 6 decimals, never rounded up", () => {
    expect(shownQuantity(3n * E18, 18, "1.000775159164630595")).toBe("3.002325");
    expect(shownQuantity(E18 / 2n, 18, "1.000000000000000000")).toBe("0.5");
  });

  test("no multiplier (USDG) or an unreadable one: the raw amount", () => {
    expect(shownQuantity(1_250_500_000n, 6, null)).toBe("1250.5");
    expect(shownQuantity(E18, 18, "two")).toBe("1");
    expect(shownQuantity(0n, 18, "2.0")).toBe("0");
  });

  test("/pot passes the multiplier for stocks only", () => {
    const bot = readFileSync(join(import.meta.dir, "..", "src", "bot", "bot.ts"), "utf8");
    expect(bot).toContain("shownQuantity(BigInt(r.rawBalance) - BigInt(r.reserved), meta.decimals, stock?.isStock ? stock.currentMultiplier : null)");
  });
});

describe("holdings refresh: a chain failure is not a paused price", () => {
  test("a stale feed (the factory refuses to price it) is 'price paused'", async () => {
    const data = encodeErrorResult({ abi: coferFactoryAbi, errorName: "StalePrice", args: ["0x322F0929c4625eD5bAd873c95208D54E1c003b2d"] });
    const stale = new ContractFunctionRevertedError({ abi: coferFactoryAbi, functionName: "valueInUsdg", data });
    expect(await valueOrPaused(async () => Promise.reject(stale))).toBeNull();
    expect(await valueOrPaused(async () => 42n)).toBe(42n);
  });

  test("an RPC failure is thrown, so the pot keeps its previous rows", async () => {
    const rpc = new HttpRequestError({ url: "https://rpc.example/SECRETKEY123", details: "fetch failed" });
    await expect(valueOrPaused(async () => Promise.reject(rpc))).rejects.toBe(rpc);
  });

  test("one pot failing does not stop the others, and is logged without the URL", async () => {
    const pots = ["0x00000000000000000000000000000000000000a1", "0x00000000000000000000000000000000000000a2", "0x00000000000000000000000000000000000000a3"] as Address[];
    const done: Address[] = [];
    const logged: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void logged.push(a.join(" "));
    let r;
    try {
      r = await refreshHoldings({
        pots: async () => pots,
        refresh: async (pot) => {
          if (pot === pots[0]) throw new HttpRequestError({ url: "https://rpc.example/SECRETKEY123", details: "fetch failed" });
          done.push(pot);
        },
      });
    } finally {
      console.error = orig;
    }
    expect(done).toEqual([pots[1]!, pots[2]!]);
    expect(r).toEqual({ pots: 3, failed: 1 });
    expect(logged.length).toBe(1);
    expect(logged[0]).toContain(`cofer-keeper holdings ${pots[0]}`);
    expect(logged[0]).not.toContain("SECRETKEY123");
  });
});
