import { describe, expect, test } from "bun:test";
import { rpcCrossCheck, type CrossCheckDeps } from "../src/keeper/rpcCrossCheck";
import type { AlertDeps } from "../src/keeper/alerts";

function world(o: { serverChain?: number | null; publicChain?: number | null; serverHead?: bigint; publicHead?: bigint }) {
  const st = { serverChain: 4663 as number | null, publicChain: 4663 as number | null, serverHead: 1000n, publicHead: 1000n, ...o };
  let now = 1_800_000_000;
  let since: number | null = null;
  const open = new Map<string, string>();
  const sent: string[] = [];
  const alerts: AlertDeps = { open: async (k, t) => (open.has(k) ? false : (open.set(k, t), true)), close: async (k) => { const t = open.get(k) ?? null; open.delete(k); return t; }, send: async (t) => void sent.push(t) };
  const side = (chain: () => number | null, head: () => bigint) => ({ chainId: async () => { const c = chain(); if (c === null) throw new Error("down"); return c; }, head: async () => head() });
  const deps: CrossCheckDeps = {
    server: side(() => st.serverChain, () => st.serverHead),
    publicRpc: side(() => st.publicChain, () => st.publicHead),
    expectedChainId: 4663,
    now: () => now,
    laggingSince: async () => since,
    setLaggingSince: async (t) => void (since = t),
    alerts,
  };
  return { deps, st, open, sent, tick: (s: number) => (now += s) };
}

describe("RPC cross-check", () => {
  test("in step: no alert", async () => {
    const w = world({});
    expect(await rpcCrossCheck(w.deps)).toEqual({ wrongChain: false, lagBlocks: 0n });
    expect(w.sent).toEqual([]);
  });

  test("a wrong chain is an emergency at once", async () => {
    const w = world({ serverChain: 46630, publicChain: 4663 });
    expect((await rpcCrossCheck(w.deps)).wrongChain).toBe(true);
    expect(w.sent[0]).toContain("rpc-wrong-chain");
    expect(w.sent[0]).toContain("answers chain 46630");
  });

  test("lagging: only after 5 minutes over the limit, and it clears when caught up", async () => {
    const w = world({ serverHead: 1000n, publicHead: 1500n });
    await rpcCrossCheck(w.deps);
    expect(w.open.size).toBe(0);
    w.tick(240);
    await rpcCrossCheck(w.deps);
    expect(w.open.size).toBe(0);
    w.tick(61);
    await rpcCrossCheck(w.deps);
    expect([...w.open.keys()]).toEqual(["rpc-lagging"]);
    w.st.serverHead = 1500n;
    w.tick(60);
    await rpcCrossCheck(w.deps);
    expect(w.open.size).toBe(0);
  });

  test("both down, or the public RPC down: nothing posted (rpc-down covers the server)", async () => {
    expect(await rpcCrossCheck(world({ serverChain: null, publicChain: null }).deps)).toEqual({ wrongChain: false, lagBlocks: null });
    const w = world({ publicChain: null });
    expect(await rpcCrossCheck(w.deps)).toEqual({ wrongChain: false, lagBlocks: null });
    expect(w.sent).toEqual([]);
  });
});
