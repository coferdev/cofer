import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ContractFunctionRevertedError, encodeErrorResult, HttpRequestError, type Address } from "viem";
import { coferFactoryAbi } from "../src/chain/abi";
import { isUsdgUpdating, justPastLimit, PRICE_UPDATING_GRACE_SEC, PRICE_UPDATING_TEXT, stalePriceAsset } from "../src/core/priceUpdating";
import { navReadFailureText } from "../src/core/betaCap";

const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
const TSLA = "0x322F0929c4625eD5bAd873c95208D54E1c003b2d" as Address;
const FACTORY = "0x0d6e43d4d7944408d9a5A10BC57B4348d61cD764" as Address;
const DAY = 86_400;
const NOW = 1_800_000_000;

const revert = (errorName: "StalePrice" | "BadPrice", asset: Address) =>
  new ContractFunctionRevertedError({ abi: coferFactoryAbi, functionName: "quote", data: encodeErrorResult({ abi: coferFactoryAbi, errorName, args: [asset] }) });

/** A chain where USDG last updated `ageSec` ago and is listed with a 24h limit. */
function chain(ageSec: number, opts: { fail?: boolean } = {}) {
  return {
    async readContract(a: { functionName: string }) {
      if (opts.fail) throw new HttpRequestError({ url: "https://rpc.example/KEY", details: "fetch failed" });
      if (a.functionName === "priceUpdatedAt") return BigInt(NOW - ageSec);
      if (a.functionName === "assetInfo") return { maxStaleness: DAY };
      throw new Error(`unexpected read ${a.functionName}`);
    },
    async getBlock() {
      return { timestamp: BigInt(NOW) };
    },
  };
}

describe("the daily USDG update window: how far past the limit counts as updating", () => {
  test("the grace is 5 minutes", () => {
    expect(PRICE_UPDATING_GRACE_SEC).toBe(300);
  });

  test("from 1 second to 5 minutes past the limit, inclusive", () => {
    const f = (age: number) => justPastLimit({ updatedAt: NOW - age, maxStaleness: DAY }, NOW);
    expect(f(DAY)).toBe(false); // at the limit the contract still accepts it
    expect(f(DAY + 1)).toBe(true);
    expect(f(DAY + 30)).toBe(true); // the real window
    expect(f(DAY + 300)).toBe(true);
    expect(f(DAY + 301)).toBe(false); // a real feed problem
    expect(f(10)).toBe(false);
  });

  test("a missing or future update time is never 'updating'", () => {
    expect(justPastLimit({ updatedAt: 0, maxStaleness: DAY }, NOW)).toBe(false);
    expect(justPastLimit({ updatedAt: NOW + 5, maxStaleness: DAY }, NOW)).toBe(false);
  });
});

describe("which refusal is the USDG update window", () => {
  test("reads the asset from StalePrice(asset) only", () => {
    expect(stalePriceAsset(revert("StalePrice", USDG))?.toLowerCase()).toBe(USDG.toLowerCase());
    expect(stalePriceAsset(revert("BadPrice", USDG))).toBeUndefined();
    expect(stalePriceAsset(new HttpRequestError({ url: "https://rpc.example", details: "x" }))).toBeUndefined();
    expect(stalePriceAsset("not an error")).toBeUndefined();
  });

  test("USDG 30 seconds past its limit: updating", async () => {
    expect(await isUsdgUpdating(revert("StalePrice", USDG), chain(DAY + 30), FACTORY, USDG)).toBe(true);
  });

  test("USDG more than 5 minutes past its limit: not updating (a real feed problem)", async () => {
    expect(await isUsdgUpdating(revert("StalePrice", USDG), chain(DAY + 301), FACTORY, USDG)).toBe(false);
  });

  test("a stale stock is never 'updating', even when USDG is just past its limit", async () => {
    expect(await isUsdgUpdating(revert("StalePrice", TSLA), chain(DAY + 30), FACTORY, USDG)).toBe(false);
  });

  test("a bad USDG price is not 'updating'", async () => {
    expect(await isUsdgUpdating(revert("BadPrice", USDG), chain(DAY + 30), FACTORY, USDG)).toBe(false);
  });

  test("a failed read falls back to the usual text", async () => {
    expect(await isUsdgUpdating(revert("StalePrice", USDG), chain(DAY + 30, { fail: true }), FACTORY, USDG)).toBe(false);
  });
});

describe("what members see", () => {
  test("the signer page's group-value refusal says the price is updating", () => {
    const t = navReadFailureText(revert("StalePrice", USDG), true);
    expect(t).toBe(`${PRICE_UPDATING_TEXT} Nothing was sent.`);
    expect(t).not.toContain("market");
  });

  test("otherwise the market-closed text is unchanged", () => {
    expect(navReadFailureText(revert("StalePrice", USDG))).toContain("Try again when the market reopens");
  });

  test("the bot's price check and the signer page both use it", () => {
    const src = (f: string) => readFileSync(join(import.meta.dir, "..", "src", f), "utf8");
    const bot = src("bot/bot.ts");
    const quote = bot.slice(bot.indexOf("async function oracleQuote"), bot.indexOf("async function buildSwap"));
    expect(quote).toContain("isUsdgUpdating(e,");
    expect(quote.indexOf("PRICE_UPDATING_TEXT")).toBeLessThan(quote.indexOf("market closed")); // checked first
    expect(src("web/client.ts")).toMatch(/navReadFailureText\(err, updating\)/);
  });
});
