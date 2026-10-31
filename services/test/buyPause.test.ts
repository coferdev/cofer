import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buyPause, corporateActionPending, potNote, type StockState } from "../src/core/buyPause";
import { continuityAlertKey, PENDING_WINDOW_SEC } from "../src/core/continuity";

const H = 3600;
const EFFECTIVE = new Date("2026-11-02T14:30:00Z");
const T = Math.floor(EFFECTIVE.getTime() / 1000);
const tsla = (p: Partial<StockState> = {}): StockState => ({ symbol: "TSLA", currentMultiplier: "1.000000000000000000", pendingMultiplier: null, pendingEffectiveAt: null, ...p });
const split = tsla({ pendingMultiplier: "2.000000000000000000", pendingEffectiveAt: EFFECTIVE });

describe("buys pause around a corporate action", () => {
  test("nothing pending, no alert: buys are open", () => {
    expect(buyPause(tsla(), false, T)).toBeNull();
    expect(potNote(tsla(), false, T)).toBeNull();
  });

  test("an announced split pauses buys from the announcement until 6h after it takes effect", () => {
    for (const now of [T - 3 * 24 * H, T - 1, T, T + PENDING_WINDOW_SEC - 1]) expect(corporateActionPending(split, now)).toBe(true);
    expect(corporateActionPending(split, T + PENDING_WINDOW_SEC)).toBe(false);
    expect(buyPause(split, false, T - H)).toBe(
      "TSLA has a corporate action coming (multiplier 1 → 2 on 2026-11-02 14:30 UTC). New buys of TSLA are paused until a few hours after it takes effect. Selling and /exit are not affected.",
    );
    expect(potNote(split, false, T - H)).toBe("corporate action pending, buys paused");
  });

  test("an announced change with no time stays paused (fail closed)", () => {
    const noTime = tsla({ pendingMultiplier: "2.0" });
    expect(corporateActionPending(noTime, T + 30 * 24 * H)).toBe(true);
    expect(buyPause(noTime, false, T)).toContain("(multiplier 1 → 2)");
  });

  test("an open continuity alert pauses buys until it clears", () => {
    expect(buyPause(tsla(), true, T)).toBe(
      "TSLA's price and multiplier don't agree right now, so new buys of TSLA are paused until that is checked. Selling and /exit are not affected.",
    );
    expect(potNote(tsla(), true, T)).toBe("price being checked, buys paused");
  });

  test("an unreadable multiplier from the issuer still pauses, shown as ?", () => {
    expect(buyPause(tsla({ pendingMultiplier: "two", pendingEffectiveAt: EFFECTIVE }), false, T)).toContain("multiplier 1 → ?");
  });
});

describe("where the pause applies", () => {
  const bot = readFileSync(join(import.meta.dir, "..", "src", "bot", "bot.ts"), "utf8");
  const cmd = (name: string) => {
    const start = bot.indexOf(`bot.command(${name}`);
    return bot.slice(start, bot.indexOf("bot.command(", start + 1));
  };

  test("/buy checks it before building the vote", () => {
    const buy = cmd('"buy"');
    const check = buy.indexOf("const paused = buyPause(asset, await continuityOpen(asset.address)");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(buy.indexOf("await propose("));
  });

  test("/sell, /exit, /send and /spend never check it", () => {
    for (const name of ['"sell"', '["exit", "claim"]', '"send"', '"spend"']) {
      const body = cmd(name);
      expect(body.length).toBeGreaterThan(0);
      expect(body).not.toMatch(/buyPause|continuityOpen|corporateActionPending/);
    }
    expect(bot.match(/buyPause\(/g)?.length).toBe(1);
  });

  test("the bot reads the same alert the keeper opens", () => {
    const keeper = readFileSync(join(import.meta.dir, "..", "src", "keeper", "keeper.ts"), "utf8");
    expect(keeper).toContain("await checkAlert(continuityAlertKey(t.asset), r.problem, deps.alerts);");
    expect(bot).toContain("where: eq(schema.alerts.key, continuityAlertKey(asset))");
    expect(continuityAlertKey("0x322F0929c4625eD5bAd873c95208D54E1c003b2d")).toBe("continuity:0x322f0929c4625ed5bad873c95208d54e1c003b2d");
  });
});
