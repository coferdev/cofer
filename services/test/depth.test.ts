import { describe, expect, test } from "bun:test";
import { chooseTier, listingDepth, type TierQuote } from "../src/chain/quotes";
import { DEPTH_MAX_GAP_BPS, DEPTH_TEST_USDG, depthRefusal, depthTestSize, gapBps, passesDepth } from "../src/core/depth";

const ok = (fee: number, out: bigint): TierQuote => ({ fee, status: "ok", pool: "0x0000000000000000000000000000000000000001", path: "0x", out });
const none = (fee: number): TierQuote => ({ fee, status: "no-pool" });
const rpc = (fee: number): TierQuote => ({ fee, status: "rpc-error", error: new Error("x") });

describe("depth rule", () => {
  test("the owner's numbers live in one place", () => {
    expect(DEPTH_TEST_USDG).toBe(10_000_000_000n); // 10,000 USDG
    expect(DEPTH_MAX_GAP_BPS).toBe(200); // 2%
  });

  test("within 2% of the oracle passes, exactly at the edge included", () => {
    expect(passesDepth(10_000n, 10_000n)).toBe(true);
    expect(passesDepth(9_800n, 10_000n)).toBe(true); // exactly 2% below
    expect(passesDepth(9_799n, 10_000n)).toBe(false);
    expect(passesDepth(11_000n, 10_000n)).toBe(true); // paying more than the oracle is fine
    expect(passesDepth(1n, 0n)).toBe(false); // no oracle price: fail closed
    expect(gapBps(9_800n, 10_000n)).toBe(-200);
  });

  test("buys are tested at max(trade, 10,000 USDG); sells at their own size", () => {
    expect(depthTestSize("buy", 100_000_000n)).toBe(DEPTH_TEST_USDG);
    expect(depthTestSize("buy", 25_000_000_000n)).toBe(25_000_000_000n);
    expect(depthTestSize("sell", 5n)).toBe(5n);
    expect(depthTestSize("sell", 10n ** 24n)).toBe(10n ** 24n);
  });

  test("refusal text names the numbers and suggests a smaller sale", () => {
    expect(depthRefusal("buy")).toContain("10000 USDG");
    expect(depthRefusal("buy")).toContain("2%");
    expect(depthRefusal("sell")).toContain("smaller part");
  });
});

describe("tier choice for a vote", () => {
  test("a thin tier is skipped even when it pays a hair more on a small trade (TSLA, seen live)", () => {
    // $100 trade: 1% pays 0.249935, 0.3% pays 0.249928. At 10,000 USDG: 1% is 6.9% short, 0.3% is 0.35% short.
    const trade = [none(100), ok(500, 248_158n), ok(3000, 249_928n), ok(10_000, 249_935n)];
    const depth = [none(100), ok(500, 1_940_000n), ok(3000, 25_208_000n), ok(10_000, 23_562_000n)];
    const c = chooseTier(trade, depth, 25_297_000n);
    expect(c.kind).toBe("ok");
    expect(c.kind === "ok" && c.quote.fee).toBe(3000);
  });

  test("pools that quote but none deep enough: too thin", () => {
    expect(chooseTier([ok(3000, 90n)], [ok(3000, 90n)], 100n).kind).toBe("too-thin");
  });

  test("nothing quotes: no pool", () => {
    expect(chooseTier([none(500)], [none(500)], 100n).kind).toBe("no-pool");
  });

  test("an RPC error at either size refuses, even if another tier is fine", () => {
    expect(chooseTier([ok(500, 100n), rpc(3000)], [ok(500, 100n), none(3000)], 100n).kind).toBe("rpc-error");
    expect(chooseTier([ok(500, 100n)], [ok(500, 100n), rpc(3000)], 100n).kind).toBe("rpc-error");
  });

  test("a sale is judged at its own size: passing there is enough", () => {
    const sale = [ok(500, 99n)];
    const c = chooseTier(sale, sale, 100n);
    expect(c.kind === "ok" && c.quote.fee).toBe(500);
  });
});

describe("listing", () => {
  test("needs a deep pool both to buy from and to sell into (tiers may differ)", () => {
    const v = listingDepth([ok(500, 99n), ok(3000, 90n)], [ok(500, 90n), ok(3000, 99n)], 100n, 100n);
    expect(v).toEqual({ rpcError: false, buyTiers: [500], sellTiers: [3000], ok: true });
  });

  test("deep only one way is refused", () => {
    expect(listingDepth([ok(500, 99n)], [ok(500, 90n)], 100n, 100n).ok).toBe(false);
    expect(listingDepth([ok(500, 90n)], [ok(500, 99n)], 100n, 100n).ok).toBe(false);
  });

  test("an RPC error is never a pass", () => {
    const v = listingDepth([ok(500, 99n), rpc(3000)], [ok(500, 99n)], 100n, 100n);
    expect(v.rpcError).toBe(true);
    expect(v.ok).toBe(false);
  });
});
