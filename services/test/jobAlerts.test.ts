import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Job } from "bullmq";
import { JOB_FAIL_ALERT_AFTER, jobAlertKey, jobFailingText, watchJobFailures } from "../src/keeper/jobAlerts";
import type { AlertDeps } from "../src/keeper/alerts";

const SRC = join(import.meta.dir, "..", "src");

function setup() {
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
  const w = Object.assign(new EventEmitter(), { name: "cofer-keeper" });
  const counts = watchJobFailures(w as never, alerts);
  const job = (name: string, attemptsMade = 1, attempts?: number) => ({ name, attemptsMade, opts: attempts ? { attempts } : {} }) as unknown as Job;
  const fail = async (j: Job, msg = "connect ECONNREFUSED https://db.internal/SECRETKEY123") => {
    w.emit("failed", j, Object.assign(new Error(msg), { name: "PostgresError" }));
    await Bun.sleep(0);
  };
  const ok = async (name: string) => {
    w.emit("completed", job(name));
    await Bun.sleep(0);
  };
  return { open, sent, counts, job, fail, ok };
}

describe("a background job that keeps failing", () => {
  test("the setting: 3 in a row", () => {
    expect(JOB_FAIL_ALERT_AFTER).toBe(3);
  });

  test("one or two failures: nothing; the third in a row: one alert, not repeated", async () => {
    const s = setup();
    await s.fail(s.job("holdings"));
    await s.fail(s.job("holdings"));
    expect(s.sent).toEqual([]);
    await s.fail(s.job("holdings"));
    await s.fail(s.job("holdings"));
    expect(s.sent.length).toBe(1);
    expect(s.sent[0]).toBe('Background job "holdings" (cofer-keeper) has failed 3 times in a row. Last error: PostgresError: connect ECONNREFUSED <url>. See the log for details.');
    expect(s.sent[0]).not.toContain("SECRETKEY123");
  });

  test("its next success clears it, once", async () => {
    const s = setup();
    for (let i = 0; i < 3; i++) await s.fail(s.job("stocks"));
    await s.ok("stocks");
    await s.ok("stocks");
    expect(s.sent.length).toBe(2);
    expect(s.sent[1]).toStartWith('Cleared (it succeeded again): Background job "stocks"');
    expect(s.open.size).toBe(0);
  });

  test("a success in between starts the count again", async () => {
    const s = setup();
    await s.fail(s.job("sweep"));
    await s.fail(s.job("sweep"));
    await s.ok("sweep");
    await s.fail(s.job("sweep"));
    await s.fail(s.job("sweep"));
    expect(s.sent).toEqual([]);
  });

  test("a failure that will still be retried does not count", async () => {
    const s = setup();
    for (let i = 0; i < 5; i++) await s.fail(s.job("card", 1, 3)); // attempt 1 of 3
    expect(s.sent).toEqual([]);
    expect(s.counts.get("card")).toBeUndefined();
  });

  test("different jobs are counted separately", async () => {
    const s = setup();
    await s.fail(s.job("feeds"));
    await s.fail(s.job("ops"));
    await s.fail(s.job("feeds"));
    await s.fail(s.job("ops"));
    expect(s.sent).toEqual([]);
    expect([...s.counts.entries()]).toEqual([
      ["feeds", 2],
      ["ops", 2],
    ]);
  });

  test("an alert left open before a restart is cleared by the first success after it", async () => {
    const s = setup();
    s.open.set(jobAlertKey("cofer-keeper", "holdings"), "old alert");
    await s.ok("holdings");
    expect(s.sent).toEqual(["Cleared (it succeeded again): old alert"]);
  });

  test("a long error is cut to keep the alert short", () => {
    const t = jobFailingText("q", "j", 3, new Error("x".repeat(1000)));
    expect(t.length).toBeLessThan(320);
  });
});

describe("wiring", () => {
  const read = (...p: string[]) => readFileSync(join(SRC, ...p), "utf8");
  test("the keeper and notifier workers are watched; the relay worker is not (votes have their own alert)", () => {
    for (const f of [["keeper", "keeper.ts"], ["notifier", "notifier.ts"]]) expect(read(...f)).toMatch(/const w = startWorker\([\s\S]*?\);\n  watchJobFailures\(w\);\n  return w;/);
    expect(read("relayer", "relayer.ts")).not.toContain("watchJobFailures");
  });
});
