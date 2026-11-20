import { describe, expect, test } from "bun:test";
import { priceJumpProblem } from "../src/core/priceJump";
import { priceJumps, type PriceJumpDeps } from "../src/keeper/keeper";
import type { AlertDeps } from "../src/keeper/alerts";

const WAD = 10n ** 18n;
const r = (answer: number, updatedAt: number, multiplier = WAD) => ({ answer: BigInt(Math.round(answer * 1e8)), updatedAt, multiplier });

describe("price-jump alarm", () => {
  test("a stock moving over 20% between two readings is a jump; 15% is not", () => {
    expect(priceJumpProblem("TSLA", r(300, 1), r(250, 2), { usdg: false })).toBeNull(); // 16.7%
    expect(priceJumpProblem("TSLA", r(300, 1), r(200, 2), { usdg: false })).toBe("TSLA price feed moved 33.3% between two readings (300 to 200), more than the 20% limit. Deposits and swaps use this price; exits never do.");
  });

  test("USDG has a 2% limit", () => {
    expect(priceJumpProblem("USDG", r(1, 1), r(0.99, 2), { usdg: true })).toBeNull();
    expect(priceJumpProblem("USDG", r(1, 1), r(0.97, 2), { usdg: true })).toContain("more than the 2% limit");
  });

  test("a move the multiplier explains is not a jump (the feed includes the multiplier: it doubles, the feed doubles)", () => {
    expect(priceJumpProblem("NVDA", r(1000, 1), r(2000, 2, 2n * WAD), { usdg: false })).toBeNull();
    // the same move without the multiplier change is a jump
    expect(priceJumpProblem("NVDA", r(1000, 1), r(2000, 2), { usdg: false })).toContain("moved 100.0%");
  });

  test("an announced multiplier, before it takes effect on the token, explains the move", () => {
    expect(priceJumpProblem("NVDA", r(1000, 1), r(2010, 2), { usdg: false, pendingMultiplier: 2n * WAD })).toBeNull();
    expect(priceJumpProblem("NVDA", r(1000, 1), r(3000, 2), { usdg: false, pendingMultiplier: 2n * WAD })).toContain("moved 200.0%");
  });

  test("no new reading (same feed time) is never compared", () => {
    expect(priceJumpProblem("TSLA", r(300, 5), r(100, 5), { usdg: false })).toBeNull();
  });

  test("the job: opens on a jump, clears on the next quiet reading, quiet periods do nothing", async () => {
    const kept = new Map<string, ReturnType<typeof r>>();
    const open = new Map<string, string>();
    const sent: string[] = [];
    const alerts: AlertDeps = { open: async (k, t) => (open.has(k) ? false : (open.set(k, t), true)), close: async (k) => { const t = open.get(k) ?? null; open.delete(k); return t; }, send: async (t) => void sent.push(t) };
    let reading = r(300, 1);
    const deps: PriceJumpDeps = {
      targets: async () => [{ symbol: "TSLA", asset: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", usdg: false, pending: null }],
      read: async () => reading,
      previous: async (a) => kept.get(a) ?? null,
      keep: async (a, x) => void kept.set(a, x as ReturnType<typeof r>),
      alerts,
    };
    expect(await priceJumps(deps)).toEqual([{ asset: "TSLA", jump: false }]); // first reading: kept only
    expect(await priceJumps(deps)).toEqual([]); // same reading again: nothing
    reading = r(150, 2);
    expect(await priceJumps(deps)).toEqual([{ asset: "TSLA", jump: true }]);
    expect(sent[0]).toContain("price-jump-TSLA");
    reading = r(152, 3);
    expect(await priceJumps(deps)).toEqual([{ asset: "TSLA", jump: false }]);
    expect(open.size).toBe(0);
  });
});
