import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HttpRequestError } from "viem";
import { INDEXER_MAX_LAG_SEC, indexerLagProblem } from "../src/core/indexerLag";
import { checkIndexerLag, INDEXER_LAG_ALERT } from "../src/keeper/keeper";
import type { AlertDeps } from "../src/keeper/alerts";

const T0 = 1_800_000_000;
const RATE = 10n; // RHC: about 10 blocks a second
/** Block n's time on a chain making 10 blocks a second. */
const timeOf = (n: bigint) => T0 + Number(n / RATE);

function fakeAlerts() {
  const open = new Map<string, string>();
  const sent: string[] = [];
  const alerts: AlertDeps = {
    async open(k, t) {
      if (open.has(k)) return false;
      open.set(k, t);
      return true;
    },
    async close(k) {
      const t = open.get(k) ?? null;
      open.delete(k);
      return t;
    },
    async send(t) {
      sent.push(t);
    },
  };
  return { alerts, open, sent };
}

describe("indexer lag: the rule", () => {
  const at = (cursor: bigint | null, target: bigint) => indexerLagProblem({ cursor, target, cursorTime: cursor === null ? null : timeOf(cursor), targetTime: timeOf(target) });

  test("the setting: 5 minutes", () => {
    expect(INDEXER_MAX_LAG_SEC).toBe(300);
  });

  test("caught up, or up to 5 minutes behind: fine", () => {
    expect(at(10_000n, 10_000n)).toBeNull();
    expect(at(10_005n, 10_000n)).toBeNull();
    expect(at(10_000n, 10_000n + 3_000n)).toBeNull(); // exactly 5 minutes
  });

  test("more than 5 minutes behind: the alert, with both block numbers", () => {
    expect(at(10_000n, 10_000n + 7_200n)).toBe(
      "The indexer is 12m behind the chain (last indexed block 10000, chain at 17200). Votes, members and balances shown by the bot may be out of date. Exits and the contracts are not affected.",
    );
  });

  test("never saved a block: the alert", () => {
    expect(at(null, 500n)).toBe("The indexer has not saved any block yet (chain at 500). Votes, members and balances shown by the bot may be out of date. Exits and the contracts are not affected.");
  });
});

describe("indexer lag: the ops job", () => {
  function run(state: { cursor: bigint | null; head: bigint }, alerts: AlertDeps, failChain = false) {
    return checkIndexerLag({
      cursor: async () => state.cursor,
      head: async () => {
        if (failChain) throw new HttpRequestError({ url: "https://rpc.example/SECRETKEY123", details: "fetch failed" });
        return state.head;
      },
      blockTime: async (n) => timeOf(n),
      confirmations: 20,
      alerts,
    });
  }

  test("stuck indexer: alerts once, stays quiet while stuck, clears when it catches up", async () => {
    const { alerts, sent } = fakeAlerts();
    const s = { cursor: 1_000n as bigint | null, head: 1_000n + 20n + 6_000n }; // 10 minutes behind
    expect(await run(s, alerts)).toBe(600);
    s.head += 3_000n; // 5 more minutes, still stuck
    await run(s, alerts);
    s.cursor = s.head - 20n; // caught up
    expect(await run(s, alerts)).toBe(0);
    expect(sent.length).toBe(2);
    expect(sent[0]).toStartWith("The indexer is 10m behind the chain");
    expect(sent[1]).toStartWith("Cleared: The indexer is 10m behind");
  });

  test("the usual 20-block wait is not counted as lag", async () => {
    const { alerts, sent } = fakeAlerts();
    expect(await run({ cursor: 5_000n, head: 5_020n }, alerts)).toBe(0);
    expect(sent).toEqual([]);
  });

  test("a failed chain read changes nothing and logs no URL", async () => {
    const { alerts, open, sent } = fakeAlerts();
    open.set(INDEXER_LAG_ALERT, "behind");
    const logged: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void logged.push(a.join(" "));
    try {
      expect(await run({ cursor: 1n, head: 100_000n }, alerts, true)).toBeNull();
    } finally {
      console.error = orig;
    }
    expect(open.has(INDEXER_LAG_ALERT)).toBe(true);
    expect(sent).toEqual([]);
    expect(logged.join(" ")).not.toContain("SECRETKEY123");
  });

  test("runs in the keeper's ops job and reads the indexer's own cursor", () => {
    const keeper = readFileSync(join(import.meta.dir, "..", "src", "keeper", "keeper.ts"), "utf8");
    expect(keeper).toContain("indexerLagSec: () => checkIndexerLag(),");
    expect(keeper).toContain("where: eq(schema.cursors.name, CURSOR)");
    const indexer = readFileSync(join(import.meta.dir, "..", "src", "indexer", "indexer.ts"), "utf8");
    expect(indexer).toContain('export const CURSOR = "main";');
  });
});
