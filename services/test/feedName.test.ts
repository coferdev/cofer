import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { feedNameProblem } from "../src/core/feedName";

describe("a feed must name the asset it is used for, priced in USD", () => {
  test("the real Robinhood Chain feed names (read on 2026-11-05) fit their assets", () => {
    expect(feedNameProblem("USDG / USD", "USDG")).toBeNull();
    expect(feedNameProblem("RHTSLA / USD", "TSLA")).toBeNull();
    expect(feedNameProblem("RHNVDA / USD", "NVDA")).toBeNull();
    expect(feedNameProblem("RHSPY / USD", "SPY")).toBeNull();
    expect(feedNameProblem("Robinhood AAPL / USD", "AAPL")).toBeNull();
  });

  test("case and spacing do not matter", () => {
    expect(feedNameProblem("  rhtsla/usd ", "tsla")).toBeNull();
  });

  test("a feed address mixed up with another stock's is refused", () => {
    expect(feedNameProblem("RHNVDA / USD", "TSLA")).toBe('feed is "RHNVDA / USD", not TSLA');
    expect(feedNameProblem("USDG / USD", "TSLA")).toBe('feed is "USDG / USD", not TSLA');
  });

  test("look-alike names are refused", () => {
    expect(feedNameProblem("RHTSLAX / USD", "TSLA")).not.toBeNull();
    expect(feedNameProblem("TSLA2 / USD", "TSLA")).not.toBeNull();
    expect(feedNameProblem("RH TSLA / USD", "TSLA")).not.toBeNull();
    expect(feedNameProblem("RHTSLA / USD", "SLA")).not.toBeNull();
  });

  test("a feed not priced in USD is refused", () => {
    expect(feedNameProblem("RHTSLA / ETH", "TSLA")).toBe('feed is "RHTSLA / ETH", which is not priced in USD');
  });

  test("a name that is not '<asset> / USD' is refused", () => {
    for (const d of ["", "RHTSLA", "RHTSLA / USD / X", " / USD"]) expect(feedNameProblem(d, "TSLA")).not.toBeNull();
    expect(feedNameProblem("RHTSLA / USD", "")).not.toBeNull();
  });

  test("the listing script and the fork test both use it, for USDG and for each stock", () => {
    const src = (f: string) => readFileSync(join(import.meta.dir, "..", "scripts", f), "utf8");
    const list = src("build-asset-list.ts");
    expect(list).toContain('functionName: "description" }), "USDG")');
    expect(list).toContain('functionName: "description" }), sym)');
    // the stock's name is checked before its price and depth are used
    expect(list.indexOf("feedNameProblem(await client.readContract({ address: feed")).toBeLessThan(list.indexOf("const stockFeed = await readFeed(feed)"));
    expect(src("fork-swap-test.ts")).toContain("feedNameProblem(desc, symbol)");
  });
});
