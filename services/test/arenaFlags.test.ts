import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { ARENA_FEATURES, arenaEnabled } from "../src/arena/flags";

const SRC = join(import.meta.dir, "..", "src");

describe("v2 switches", () => {
  test("everything is off by default, on testnet and on mainnet", () => {
    for (const f of ARENA_FEATURES) {
      expect(arenaEnabled(f, { CHAIN_ID: "4663" })).toBe(false);
      expect(arenaEnabled(f, { CHAIN_ID: "46630" })).toBe(false);
      expect(arenaEnabled(f, {})).toBe(false);
    }
  });
  test("a testnet list never turns anything on mainnet", () => {
    const all = ARENA_FEATURES.join(",");
    for (const f of ARENA_FEATURES) {
      expect(arenaEnabled(f, { CHAIN_ID: "4663", ARENA_FEATURES: all })).toBe(false);
      expect(arenaEnabled(f, { CHAIN_ID: "46630", ARENA_FEATURES: all })).toBe(true);
    }
  });
  test("mainnet turns on only what its own list names", () => {
    const env = { CHAIN_ID: "4663", ARENA_FEATURES_MAINNET: " practice ,app" };
    expect(arenaEnabled("practice", env)).toBe(true);
    expect(arenaEnabled("app", env)).toBe(true);
    expect(arenaEnabled("friend", env)).toBe(false);
    expect(arenaEnabled("freeroll", { CHAIN_ID: "46630", ARENA_FEATURES_MAINNET: "freeroll" })).toBe(false);
  });
});

describe("group accounts are untouched by v2", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
    });
  test("no existing part of the service imports v2 code except through the switches", () => {
    const hits: string[] = [];
    for (const f of files(SRC)) {
      const rel = relative(SRC, f);
      if (rel.startsWith("arena/")) continue;
      const src = readFileSync(f, "utf8");
      if (/from\s+["'][^"']*\/arena\//.test(src) && !/arenaEnabled\(/.test(src)) hits.push(rel);
    }
    expect(hits).toEqual([]);
  });
});
