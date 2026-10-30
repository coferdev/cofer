import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Address } from "viem";
import { staleHoldings } from "../src/keeper/keeper";

const POT = "0x0000000000000000000000000000000000000AbC" as Address;
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
const TSLA = "0x322F0929c4625eD5bAd873c95208D54E1c003b2d" as Address;
const render = (held: Address[]) => new PgDialect().sqlToQuery(staleHoldings(POT, held)!);

describe("holdings refresh: removing assets a pot no longer holds", () => {
  test("only USDG held (the failing case): a plain not-in list, no array operator", () => {
    const q = render([USDG]);
    expect(q.sql).toBe('("holdings"."pot" = $1 and "holdings"."asset" not in ($2))');
    expect(q.params).toEqual([POT, USDG]);
    expect(q.sql).not.toContain("any(");
  });

  test("several assets: one value per asset", () => {
    const q = render([USDG, TSLA]);
    expect(q.sql).toBe('("holdings"."pot" = $1 and "holdings"."asset" not in ($2, $3))');
    expect(q.params).toEqual([POT, USDG, TSLA]);
  });

  test("the keeper deletes with this condition, not a hand-written sql template", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "keeper", "keeper.ts"), "utf8");
    expect(src).toContain("await db().delete(schema.holdings).where(staleHoldings(pot, held));");
    expect(src).not.toMatch(/any\(\$\{/);
  });
});
