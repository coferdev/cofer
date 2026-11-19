import { describe, expect, test } from "bun:test";
import { adminCountdown, type AdminCountdownDeps, type QueuedAdminRow } from "../src/keeper/adminCountdown";
import type { AlertDeps } from "../src/keeper/alerts";

const ETA = 1_800_000_000;
function world() {
  let now = ETA - 7 * 3600;
  const open = new Map<string, string>();
  const sent: string[] = [];
  const rows: QueuedAdminRow[] = [{ id: "q1", kind: "swap fee", subject: "swap fee", newValue: "40", maxStaleness: null, eta: ETA }];
  const alerts: AlertDeps = {
    open: async (k, t) => (open.has(k) ? false : (open.set(k, t), true)),
    close: async (k) => {
      const t = open.get(k) ?? null;
      open.delete(k);
      return t;
    },
    send: async (t) => void sent.push(t),
  };
  const deps: AdminCountdownDeps = {
    queued: async () => rows,
    openIds: async () => [...new Set([...open.keys()].map((k) => k.slice(k.indexOf(":") + 1)))],
    token: async () => null,
    now: () => now,
    alerts,
  };
  return { deps, sent, open, rows, tick: (s: number) => (now += s) };
}

describe("admin change countdown", () => {
  test("one post 6 hours before, one when it can apply; never twice", async () => {
    const w = world();
    expect(await adminCountdown(w.deps)).toEqual({ soon: 0, due: 0, dropped: 0 }); // 7 hours before: nothing yet
    w.tick(3600 + 1);
    expect(await adminCountdown(w.deps)).toEqual({ soon: 1, due: 0, dropped: 0 });
    expect(w.sent[0]).toContain("admin-change-soon");
    expect(w.sent[0]).toContain("the swap fee change to 0.4%");
    w.tick(3600);
    expect((await adminCountdown(w.deps)).soon).toBe(0);
    w.tick(5 * 3600);
    expect(await adminCountdown(w.deps)).toEqual({ soon: 0, due: 1, dropped: 0 });
    expect(w.sent[1]).toContain("admin-change-due");
    expect((await adminCountdown(w.deps)).due).toBe(0);
    expect(w.sent).toHaveLength(2);
  });

  test("applied: its countdown alerts are dropped without a post", async () => {
    const w = world();
    w.tick(2 * 3600);
    await adminCountdown(w.deps);
    w.rows.length = 0;
    expect(await adminCountdown(w.deps)).toEqual({ soon: 0, due: 0, dropped: 1 });
    expect(w.open.size).toBe(0);
    expect(w.sent).toHaveLength(1);
  });
});
