import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureRelay, RELAY_RETRY_AFTER_MS, relayJobId, sweepAction } from "../src/queues";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

describe("the bug this fixes (BullMQ 5: adding a job ID the queue still holds does nothing)", () => {
  test("the add scripts return early for an existing job ID, whatever its state", () => {
    const dir = join(import.meta.dir, "..", "node_modules", "bullmq", "dist", "esm", "commands");
    for (const f of ["addStandardJob-9.lua", "addDelayedJob-6.lua"]) {
      const lua = readFileSync(join(dir, f), "utf8");
      expect(lua).toMatch(/if rcall\("EXISTS", jobIdKey\) == 1 then\s+return handleDuplicatedJob\(/);
    }
  });

  test("the relay queue keeps failed jobs (no removeOnFail), so a re-add of a stuck vote was ignored forever", () => {
    const q = readFileSync(join(import.meta.dir, "..", "src", "queues.ts"), "utf8");
    const relay = /relay: new Queue\(Q\.relay, \{[^\n]*\}\),/.exec(q)![0];
    expect(relay).toContain("attempts: 5");
    expect(relay).not.toContain("removeOnFail");
  });
});

describe("what the sweep does with a due vote's relay job", () => {
  test("no job (lost, or the vote was queued by someone else): add it", () => {
    expect(sweepAction(null, undefined, NOW)).toBe("add");
    expect(sweepAction("unknown", undefined, NOW)).toBe("add");
  });

  test("waiting, delayed or running: leave it (never a second copy of one vote)", () => {
    for (const s of ["waiting", "delayed", "active", "prioritized", "waiting-children"]) expect(sweepAction(s, undefined, NOW)).toBe("leave");
  });

  test("failed all its tries: retried 5 minutes after it failed, not sooner", () => {
    expect(RELAY_RETRY_AFTER_MS).toBe(5 * MIN);
    expect(sweepAction("failed", NOW - 4 * MIN, NOW)).toBe("leave");
    expect(sweepAction("failed", NOW - 5 * MIN, NOW)).toBe("retry-failed");
  });

  test("finished but the vote still has not run: retried the same way", () => {
    expect(sweepAction("completed", NOW - MIN, NOW)).toBe("leave");
    expect(sweepAction("completed", NOW - 6 * MIN, NOW)).toBe("retry-completed");
  });
});

describe("ensureRelay against a stand-in queue", () => {
  function queue(job?: { state: string; finishedOn?: number }) {
    const calls: { id?: string; retried?: { state: string; opts: unknown } } = {};
    const q = {
      async getJob(id: string) {
        calls.id = id;
        if (!job) return undefined;
        return {
          finishedOn: job.finishedOn,
          getState: async () => job.state,
          retry: async (state: "failed" | "completed", opts: { resetAttemptsMade: boolean; resetAttemptsStarted: boolean }) => void (calls.retried = { state, opts }),
        };
      },
    };
    return { q, calls };
  }

  test("a failed job is retried with a fresh set of tries, under its own ID", async () => {
    const { q, calls } = queue({ state: "failed", finishedOn: NOW - 10 * MIN });
    expect(await ensureRelay("0xabc", 1_800_000_002, q, NOW)).toBe("retry-failed");
    expect(calls.id).toBe("relay:0xabc:1800000002");
    expect(calls.retried).toEqual({ state: "failed", opts: { resetAttemptsMade: true, resetAttemptsStarted: true } });
  });

  test("a running job is left alone", async () => {
    const { q, calls } = queue({ state: "active" });
    expect(await ensureRelay("0xabc", undefined, q, NOW)).toBe("leave");
    expect(calls.id).toBe("relay:0xabc:0");
    expect(calls.retried).toBeUndefined();
  });

  test("job IDs match what the relayer uses", () => {
    expect(relayJobId("0xabc")).toBe("relay:0xabc:0");
    expect(relayJobId("0xabc", 1_800_000_002)).toBe("relay:0xabc:1800000002");
  });
});

describe("the sweep", () => {
  test("a vote waiting out its exit window is checked under the job the relayer scheduled (eta + 2)", () => {
    const keeper = readFileSync(join(import.meta.dir, "..", "src", "keeper", "keeper.ts"), "utf8");
    expect(keeper).toContain("at: r.queuedEta === null ? undefined : r.queuedEta + 2");
    expect(keeper).toContain("await ensure(d.id, d.at);");
    expect(keeper).not.toMatch(/sweepQueued[\s\S]*?enqueueRelay\(r\.id\)/);
    const relayer = readFileSync(join(import.meta.dir, "..", "src", "relayer", "relayer.ts"), "utf8");
    expect(relayer).toContain("await enqueueRelay(proposalId, eta + 2);");
    expect(relayer).toContain("await enqueueRelay(proposalId, row.queuedEta + 2);");
  });
});
