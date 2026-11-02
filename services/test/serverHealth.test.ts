import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  diskLowProblem,
  errorsSpikeProblem,
  memoryHighProblem,
  nextHighSince,
  RPC_DOWN_AFTER_SEC,
  RPC_GRACE_SEC,
  rpcDownProblem,
} from "../src/core/serverHealth";
import { serverChecks, type ServerDeps } from "../src/keeper/serverHealth";
import { checkAlert, type AlertDeps } from "../src/keeper/alerts";
import { countErrorsWith, logError } from "../src/core/errors";
import { WHO } from "../src/core/alertFormat";

const T0 = 1_800_000_000;
const MIN = 60;
const FULL_ADDRESS = /0x[0-9a-fA-F]{40}/;

function fakeAlerts(trouble = { on: false }) {
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
    rpcTrouble: async () => trouble.on,
  };
  return { alerts, open, sent, trouble };
}

/** A keeper "server" job with the chain, Redis, disk and memory faked; `tick` moves the clock. */
function server(state: { rpcUp: boolean; errors: number; diskFree: number; memUsed: number }) {
  const a = fakeAlerts();
  let clock = T0;
  let failingSince: number | null = null;
  const deps: ServerDeps = {
    now: () => clock,
    probeRpc: async () => {
      if (!state.rpcUp) throw new Error("fetch failed https://rpc.example/SECRETKEY123");
      return 1n;
    },
    rpcMark: async (ok, now) => (ok ? (failingSince = null) : (failingSince ??= now)),
    errorCount: async () => state.errors,
    diskFree: async () => state.diskFree,
    memoryUsed: async () => state.memUsed,
    isOpen: async (k) => a.open.has(k),
    memory: { highSince: null },
    alerts: a.alerts,
  };
  return { ...a, deps, run: () => serverChecks(deps), tick: (sec: number) => void (clock += sec) };
}

const healthy = () => ({ rpcUp: true, errors: 0, diskFree: 0.5, memUsed: 0.4 });

describe("server health: the rules", () => {
  test("rpc-down: only after 5 minutes of failing without a break", () => {
    expect(RPC_DOWN_AFTER_SEC).toBe(5 * MIN);
    expect(rpcDownProblem(null, T0)).toBeNull();
    expect(rpcDownProblem(T0, T0 + 4 * MIN)).toBeNull();
    expect(rpcDownProblem(T0, T0 + 5 * MIN)).toStartWith("The chain RPC has not answered for 5m.");
  });

  test("errors-spike: opens at 20 in 5 minutes, clears below 10", () => {
    expect(errorsSpikeProblem(19, false)).toBeNull();
    expect(errorsSpikeProblem(20, false)).toStartWith("20 errors were logged in the last 5m");
    expect(errorsSpikeProblem(12, true)).not.toBeNull(); // still open
    expect(errorsSpikeProblem(9, true)).toBeNull();
  });

  test("disk-low: opens under 10% free, clears at 12%", () => {
    expect(diskLowProblem(0.1, false)).toBeNull();
    expect(diskLowProblem(0.07, false)).toStartWith("The server has 7% disk space left.");
    expect(diskLowProblem(0.11, true)).not.toBeNull();
    expect(diskLowProblem(0.12, true)).toBeNull();
  });

  test("memory-high: over 90% for 5 minutes; clears under 85%", () => {
    expect(memoryHighProblem(0.95, T0, T0 + 4 * MIN, false)).toBeNull();
    expect(memoryHighProblem(0.95, T0, T0 + 5 * MIN, false)).toBe("The server has used more than 90% of its memory for 5m (now 95%). Processes may be stopped by the system.");
    expect(memoryHighProblem(0.88, T0, T0 + 9 * MIN, true)).not.toBeNull();
    expect(memoryHighProblem(0.84, null, T0, true)).toBeNull();
    expect(nextHighSince(0.95, null, T0)).toBe(T0);
    expect(nextHighSince(0.95, T0, T0 + MIN)).toBe(T0);
    expect(nextHighSince(0.8, T0, T0 + MIN)).toBeNull();
  });
});

describe("server health: the keeper job", () => {
  test("rpc-down posts once after 5 minutes, says who acts, and clears when the RPC answers", async () => {
    const st = healthy();
    const s = server(st);
    st.rpcUp = false;
    for (let i = 0; i < 5; i++) {
      await s.run();
      s.tick(MIN);
    }
    expect(s.sent).toEqual([]); // 0..4 minutes
    await s.run(); // 5 minutes
    await s.run();
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toStartWith("[cofer alert] rpc-down\nThe chain RPC has not answered for 5m.");
    expect(s.sent[0]).toEndWith("Who acts: Dev checks the RPC provider, and switches RHC_RPC_URL if it stays down.");
    expect(s.sent[0]).not.toContain("SECRETKEY123");
    st.rpcUp = true;
    await s.run();
    expect(s.sent[1]).toBe("[cofer alert] rpc-down: Cleared (the chain RPC answers again).");
  });

  test("a short RPC blip never alerts", async () => {
    const st = healthy();
    const s = server(st);
    st.rpcUp = false;
    await s.run();
    s.tick(3 * MIN);
    st.rpcUp = true;
    await s.run();
    st.rpcUp = false;
    s.tick(3 * MIN);
    await s.run();
    expect(s.sent).toEqual([]);
  });

  test("disk, memory and errors: one alert each, who acts, no addresses, then cleared", async () => {
    const st = healthy();
    const s = server(st);
    st.diskFree = 0.05;
    st.errors = 25;
    st.memUsed = 0.95;
    await s.run();
    expect(s.sent.map((t) => t.split("\n")[0])).toEqual(["[cofer alert] errors-spike", "[cofer alert] disk-low"]);
    s.tick(5 * MIN);
    await s.run();
    expect(s.sent.at(-1)!.split("\n")[0]).toBe("[cofer alert] memory-high");
    for (const t of s.sent) {
      expect(t).toContain("\nWho acts: Dev ");
      expect(t).not.toMatch(FULL_ADDRESS);
    }
    Object.assign(st, healthy());
    await s.run();
    expect(s.sent.slice(-3)).toEqual(["[cofer alert] errors-spike: Cleared.", "[cofer alert] disk-low: Cleared.", "[cofer alert] memory-high: Cleared."]);
  });

  test("one check that cannot run does not stop the others, and the job never throws", async () => {
    const s = server({ ...healthy(), diskFree: 0.05 });
    const err = spyOn(console, "error").mockImplementation(() => {});
    let out: Record<string, unknown>;
    try {
      out = await serverChecks({ ...s.deps, errorCount: async () => Promise.reject(new Error("redis down")) });
    } finally {
      err.mockRestore();
    }
    expect(out.errors).toBeNull();
    expect(out.diskFree).toBe(0.05);
    expect(s.sent.map((t) => t.split("\n")[0])).toEqual(["[cofer alert] disk-low"]);
  });
});

describe("during an RPC outage: one alert", () => {
  const lag = { name: "indexer-behind", what: "The indexer is 12m behind.", who: WHO.dev, rpcRelated: true };
  const job = { name: "job-failing", what: "Job failed 3 times.", who: WHO.dev, rpcRelated: true };

  test("indexer-behind and job-failing are held back while the RPC is failing or just recovered", async () => {
    const a = fakeAlerts({ on: true });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await checkAlert("indexer-behind", lag, a.alerts)).toBeNull();
      expect(await checkAlert("job-failing:q:j", job, a.alerts)).toBeNull();
    } finally {
      warn.mockRestore();
    }
    expect(a.sent).toEqual([]);
    expect(a.open.size).toBe(0);
  });

  test("still true after the grace period: they post normally", async () => {
    const a = fakeAlerts({ on: true });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await checkAlert("indexer-behind", lag, a.alerts);
    } finally {
      warn.mockRestore();
    }
    a.trouble.on = false; // grace period over
    expect(await checkAlert("indexer-behind", lag, a.alerts)).toBe("opened");
    expect(a.sent[0]).toStartWith("[cofer alert] indexer-behind\n");
    expect(RPC_GRACE_SEC).toBe(5 * MIN);
  });

  test("emergencies are never held back", async () => {
    const a = fakeAlerts({ on: true });
    const roles = { name: "role-changed", what: "The guardian changed.", who: WHO.emergency, emergency: true };
    expect(await checkAlert("roles-drift", roles, a.alerts)).toBe("opened");
    expect(await checkAlert("role-changed:sinks", { ...roles, rpcRelated: true }, a.alerts)).toBe("opened");
    expect(a.sent).toHaveLength(2);
  });

  test("other alerts (e.g. price-stale, relayer-low) are not held back", async () => {
    const a = fakeAlerts({ on: true });
    expect(await checkAlert("feed-stale:x", { name: "price-stale-TSLA", what: "x", who: WHO.dev }, a.alerts)).toBe("opened");
  });

  test("an alert already open stays open while held back (no clear, no repeat)", async () => {
    const a = fakeAlerts({ on: true });
    a.open.set("indexer-behind", "[cofer alert] indexer-behind\nold\nWho acts: Dev checks.");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await checkAlert("indexer-behind", lag, a.alerts)).toBeNull();
    } finally {
      warn.mockRestore();
    }
    expect(a.open.has("indexer-behind")).toBe(true);
    expect(a.sent).toEqual([]);
  });

  test("the right alerts are marked as caused by an outage", () => {
    const read = (...p: string[]) => readFileSync(join(import.meta.dir, "..", "src", ...p), "utf8");
    expect(read("keeper", "keeper.ts")).toContain("{ name: INDEXER_LAG_ALERT, what: lag, who: WHO.dev, rpcRelated: true }");
    expect(read("keeper", "jobAlerts.ts")).toContain('who: WHO.dev, rpcRelated: true }');
    expect(read("keeper", "serverHealth.ts")).toContain('who: "Dev checks the log.", rpcRelated: true }');
    expect(read("keeper", "keeper.ts").match(/rpcRelated/g)).toHaveLength(1);
  });
});

describe("error counting and wiring", () => {
  test("every logged error is counted; a broken counter never breaks logging", () => {
    let n = 0;
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      countErrorsWith(() => void n++);
      logError("a", new Error("x"));
      logError("b", new Error("y"));
      countErrorsWith(() => {
        throw new Error("counter broken");
      });
      expect(() => logError("c", new Error("z"))).not.toThrow();
    } finally {
      countErrorsWith(undefined);
      err.mockRestore();
    }
    expect(n).toBe(2);
  });

  test("every role counts errors; the keeper checks the server every minute", () => {
    const read = (...p: string[]) => readFileSync(join(import.meta.dir, "..", "src", ...p), "utf8");
    expect(read("index.ts")).toContain("countErrorsWith(() => void recordError().catch(() => {}));");
    const keeper = read("keeper", "keeper.ts");
    expect(keeper).toContain('await q.upsertJobScheduler("server", { every: 60_000 }, { name: "server" });');
    expect(keeper).toContain('case "server":\n          return serverChecks();');
  });
});
