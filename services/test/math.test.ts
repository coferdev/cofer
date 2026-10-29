import { describe, expect, test } from "bun:test";
import { getAddress } from "viem";
import { allowanceLeft, memberValue, nextResetAt, previewDeposit, previewExit, rollWindow } from "../src/core/shares";
import { displayUnits, minOutFloor, multiplierContinuityOk, quote, valueInUsdg } from "../src/core/valuation";
import { computeMinOut, encodeV3Path, swapInAfterFee } from "../src/core/swap";

describe("share math (same numbers as contracts/test/CoferPot.t.sol)", () => {
  test("first deposit: 1 USDG = 1e18 shares; second at par is exact", () => {
    const s0 = previewDeposit({ amount: 100_000_000n, nav: 0n, nonUsdgValue: 0n, totalShares: 0n, entrySpreadBps: 50 });
    expect(s0).toBe(100n * 10n ** 18n);
    const s1 = previewDeposit({ amount: 50_000_000n, nav: 100_000_000n, nonUsdgValue: 0n, totalShares: s0, entrySpreadBps: 50 });
    expect(s1).toBe(50n * 10n ** 18n);
  });

  test("entry spread applies only while non-USDG assets are held", () => {
    const base = { amount: 100_000_000n, nav: 1_000_000_000n, totalShares: 1_000n * 10n ** 18n, entrySpreadBps: 50 };
    const noStocks = previewDeposit({ ...base, nonUsdgValue: 0n });
    const withStocks = previewDeposit({ ...base, nonUsdgValue: 500_000_000n });
    expect(withStocks).toBe((noStocks * 9950n) / 10000n);
  });

  test("donation inflation does not zero out a small depositor (virtual offset)", () => {
    // attacker deposits 1 wei of USDG then donates 1,000,000 USDG
    const s = previewDeposit({ amount: 1_000_000n, nav: 1_000_000_000_001n, nonUsdgValue: 0n, totalShares: 10n ** 12n, entrySpreadBps: 0 });
    expect(s > 0n).toBe(true);
  });

  test("exit floors every asset (rounding in favour of the pot)", () => {
    expect(previewExit(10n ** 18n, 3n * 10n ** 18n, [3_000_001n, 10n])).toEqual([1_000_000n, 3n]);
    expect(previewExit(5n, 0n, [1n])).toEqual([0n]);
  });

  test("member value is pro rata over asset values", () => {
    expect(memberValue(1n, 4n, [400n, 800n])).toBe(300n);
  });

  test("allowance window rolls exactly like CoferPot._rollWindow", () => {
    const s = { allowance: 50_000_000n, period: 604800, periodStart: 1_000, spent: 30_000_000n };
    expect(allowanceLeft(s, 2_000)).toBe(20_000_000n);
    expect(allowanceLeft(s, 1_000 + 604800)).toBe(50_000_000n);
    expect(rollWindow(s, 1_000 + 3 * 604800 + 5).periodStart).toBe(1_000 + 3 * 604800);
    expect(nextResetAt(s, 2_000)).toBe(1_000 + 604800);
  });
});

describe("valuation: the feed already includes the multiplier", () => {
  const usdgFeed = { answer: 100_000_000n, decimals: 8, updatedAt: 0 };

  test("value = raw x feed, never x uiMultiplier again", () => {
    // 2-for-1 split: uiMultiplier 2e18, feed reports underlying x 2 = $500
    const h = { rawBalance: 10n ** 18n, tokenDecimals: 18, feed: { answer: 500n * 10n ** 8n, decimals: 8, updatedAt: 0 }, uiMultiplier: 2n * 10n ** 18n };
    expect(valueInUsdg(h, usdgFeed)).toBe(500_000_000n);
    expect(displayUnits(h.rawBalance, h.uiMultiplier)).toBe(2n * 10n ** 18n); // shows "2 TSLA"
  });

  test("quote matches CoferFactory.quote numbers from the Solidity suite", () => {
    const out = quote(997_000_000n, { feed: usdgFeed, tokenDecimals: 6 }, { feed: { answer: 250n * 10n ** 8n, decimals: 8, updatedAt: 0 }, tokenDecimals: 18 });
    expect(out).toBe(3_988_000_000_000_000_000n);
  });

  test("multiplier continuity check", () => {
    const one = 10n ** 18n;
    expect(multiplierContinuityOk({ prevAnswer: 250n, newAnswer: 500n, prevMultiplier: one, newMultiplier: 2n * one })).toBe(true);
    expect(multiplierContinuityOk({ prevAnswer: 250n, newAnswer: 1000n, prevMultiplier: one, newMultiplier: 2n * one })).toBe(false);
  });

  test("oracle floor", () => {
    expect(minOutFloor(10_000n, 300)).toBe(9_700n);
  });
});

describe("swap planning", () => {
  const A = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
  const B = getAddress("0x117cc2133c37B721F49dE2A7a74833232B3B4C0C");

  test("v3 path is token|fee(3 bytes)|token", () => {
    const p = encodeV3Path([A, B], [3000]);
    expect((p.length - 2) / 2).toBe(43);
    expect(p.slice(42, 48)).toBe("000bb8");
  });

  test("fee comes out of amountIn", () => {
    expect(swapInAfterFee(1_000_000_000n, 30)).toEqual({ fee: 3_000_000n, swapIn: 997_000_000n });
  });

  test("minOut = max(pool - user slip, oracle floor); off-price pools are refused", () => {
    const ok = computeMinOut({ poolOut: 1_000n, oracleOut: 1_000n, userSlipBps: 100, potMaxSlipBps: 300 });
    expect(ok).toEqual({ ok: true, minOut: 990n, floor: 970n });
    const tight = computeMinOut({ poolOut: 980n, oracleOut: 1_000n, userSlipBps: 500, potMaxSlipBps: 300 });
    expect(tight.ok && tight.minOut).toBe(970n);
    const bad = computeMinOut({ poolOut: 900n, oracleOut: 1_000n, userSlipBps: 100, potMaxSlipBps: 300 });
    expect(bad.ok).toBe(false);
  });
});
