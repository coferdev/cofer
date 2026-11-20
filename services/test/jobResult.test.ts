import { describe, expect, test } from "bun:test";
import type { Job } from "bullmq";
import { jobResult, storableResult } from "../src/queues";
import { safeJob } from "../src/core/errors";
import { rpcCrossCheck, type CrossCheckDeps } from "../src/keeper/rpcCrossCheck";

// BullMQ stores a finished job's result with JSON.stringify (Job.moveToCompleted); this is that step.
const store = (v: unknown) => JSON.stringify(v);

function crossCheckDeps(): CrossCheckDeps {
  const side = (head: bigint) => ({ chainId: async () => 4663, head: async () => head });
  return {
    server: side(1_000n),
    publicRpc: side(1_250n),
    expectedChainId: 4663,
    now: () => 1_800_000_000,
    laggingSince: async () => null,
    setLaggingSince: async () => {},
    alerts: { open: async () => true, close: async () => null, send: async () => {} },
  };
}

describe("job results", () => {
  test("the mainnet failure: the cross-check's own result cannot be stored as it is", async () => {
    const r = await rpcCrossCheck(crossCheckDeps());
    expect(r).toEqual({ wrongChain: false, lagBlocks: 250n });
    expect(() => store(r)).toThrow("JSON.stringify cannot serialize BigInt");
  });

  test("as startWorker runs it, the same result is stored, with the bigint as a decimal string", async () => {
    const run = safeJob(storableResult(async () => rpcCrossCheck(crossCheckDeps())));
    const r = await run({ name: "rpc-cross-check" } as Job);
    expect(store(r)).toBe('{"wrongChain":false,"lagBlocks":"250"}');
  });

  test("bigints at any depth, and everything else unchanged", () => {
    expect(jobResult({ a: 1n, b: [2n, { c: 3n }], d: "x", e: null, f: true, g: 1.5 })).toEqual({ a: "1", b: ["2", { c: "3" }], d: "x", e: null, f: true, g: 1.5 });
    expect(jobResult(undefined)).toBeUndefined();
    expect(jobResult(7n)).toBe("7");
    expect(jobResult(new Date(0))).toBe("1970-01-01T00:00:00.000Z");
  });

  test("startWorker wraps every job this way", async () => {
    const src = await Bun.file(new URL("../src/queues.ts", import.meta.url)).text();
    expect(src).toContain("  fn = storableResult(fn);\n  const w = new Worker(name, safeJob(fn), { connection: redis(), ...opts });");
  });

  test("a failing job still fails, through the same safe error path", async () => {
    const run = safeJob(storableResult(async () => {
      throw new Error("rpc down at https://rpc.example/key123");
    }));
    await expect(run({ name: "x" } as Job)).rejects.toThrow("rpc down");
  });
});
