import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress, zeroAddress, type Address } from "viem";
import { stockRow } from "../src/keeper/keeper";
import type { CanonicalStock } from "../src/stocks/canonical";

const TSLA: CanonicalStock = {
  symbol: "TSLA",
  address: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d",
  decimals: 18,
  currentMultiplier: "1.0",
  pendingMultiplier: "2.0",
  pendingEffectiveAt: "2026-11-02T14:30:00Z",
  status: "ACTIVE",
  tradable: true,
};
const FEED = getAddress("0x00000000000000000000000000000000000feed1");

describe("stock refresh: what is saved for each canonical stock", () => {
  test("a listed stock saves its feed (checksummed) and listed flag, plus the issuer's multipliers", () => {
    const r = stockRow(TSLA, { listed: true, feed: FEED.toLowerCase() as Address });
    for (const row of [r.insert, r.update]) {
      expect(row).toMatchObject({ listedOnChain: true, feed: FEED, symbol: "TSLA", currentMultiplier: "1.0", pendingMultiplier: "2.0", status: "ACTIVE" });
      expect(row.pendingEffectiveAt).toEqual(new Date("2026-11-02T14:30:00Z"));
    }
    expect(r.insert).toMatchObject({ address: TSLA.address, decimals: 18, isStock: true });
  });

  test("a stock the factory has never listed: not listed, no feed", () => {
    const r = stockRow(TSLA, { listed: false, feed: zeroAddress });
    expect(r.update).toMatchObject({ listedOnChain: false, feed: null });
  });

  test("chain unreachable: an existing row keeps its listed flag and feed; a new row starts as not listed", () => {
    const r = stockRow(TSLA, undefined);
    expect("listedOnChain" in r.update).toBe(false);
    expect("feed" in r.update).toBe(false);
    expect(r.update).toMatchObject({ currentMultiplier: "1.0", pendingMultiplier: "2.0" }); // issuer data still refreshed
    expect(r.insert).toMatchObject({ listedOnChain: false, feed: null });
  });

  test("nothing pending: stored as empty, not as a stale earlier value", () => {
    const r = stockRow({ ...TSLA, pendingMultiplier: null, pendingEffectiveAt: null }, { listed: true, feed: FEED });
    expect(r.update).toMatchObject({ pendingMultiplier: null, pendingEffectiveAt: null });
  });

  test("the keeper saves rows through stockRow and logs a failed chain read", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "keeper", "keeper.ts"), "utf8");
    expect(src).toContain("const row = stockRow(s, info);");
    expect(src).toContain('logError("cofer-keeper stocks", e);');
    expect(src).not.toContain("/* not listed */");
  });
});
