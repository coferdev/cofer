import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, backupCommands, countDifferences, expired, pgEnv, type Run } from "../scripts/ops/backup";
import { statusReport } from "../scripts/ops/status";

const URL_ = "postgres://cofer:s3cret@db.internal:5433/cofer?sslmode=require";

describe("cofer-ops backup", () => {
  test("connection details go to the tools as environment variables, never on a command line", () => {
    expect(pgEnv(URL_)).toEqual({ PGHOST: "db.internal", PGPORT: "5433", PGDATABASE: "cofer", PGUSER: "cofer", PGPASSWORD: "s3cret", PGSSLMODE: "require" });
    const c = backupCommands("/b", "2026-12-01", "cofer_restore_check_20261201");
    for (const cmd of [c.dump, c.create, c.restore, c.drop]) expect(cmd.join(" ")).not.toMatch(/s3cret|db\.internal|postgres:/);
    expect(c.dump).toEqual(["pg_dump", "--format=custom", "--no-owner", "--file", "/b/cofer-2026-12-01.dump"]);
  });

  test("keeps 14 days of backups and nothing else is touched", () => {
    const files = ["cofer-2026-11-17.dump", "cofer-2026-11-18.dump", "cofer-2026-12-01.dump", "last-good.json", "notes.txt"];
    expect(expired(files, "2026-12-01")).toEqual(["cofer-2026-11-17.dump"]);
  });

  test("row counts are compared table by table", () => {
    expect(countDifferences({ pots: 3, members: 9 }, { pots: 3, members: 9 })).toEqual([]);
    expect(countDifferences({ pots: 3, members: 9 }, { pots: 3 })).toEqual(["members: 9 live, missing restored"]);
  });

  test("a full run with fake tools: dump, restore into a throwaway database, compare, record, clear the alert", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bk-"));
    writeFileSync(join(dir, "cofer-2026-11-01.dump"), "old");
    const ran: string[] = [];
    const run: Run = (cmd, env) => {
      ran.push(cmd[0]!);
      expect(env.PGPASSWORD).toBe("s3cret");
      if (cmd[0] === "pg_dump") writeFileSync(cmd[cmd.length - 1]!, "dump");
      return { ok: true, err: "" };
    };
    const alerts: (string | null)[] = [];
    const r = await backup({ dir, databaseUrl: URL_, run, counts: async () => ({ pots: 3, members: 9 }), today: () => "2026-12-01", alert: async (p) => void alerts.push(p) });
    expect(r).toMatchObject({ ok: true, tables: 2, removed: ["cofer-2026-11-01.dump"] });
    expect(ran).toEqual(["pg_dump", "dropdb", "createdb", "pg_restore", "dropdb"]);
    expect(alerts).toEqual([null]);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "cofer-2026-12-01.dump")).mode & 0o777).toBe(0o600);
    const last = JSON.parse(readFileSync(join(dir, "last-good.json"), "utf8"));
    expect(last).toMatchObject({ day: "2026-12-01", file: "cofer-2026-12-01.dump", tables: 2 });
    expect(statusReport({ units: [], release: null, indexer: null, queues: null, alerts: [], settings: [], lastBackup: last })).toContain("Backup:   last good 2026-12-01 (cofer-2026-12-01.dump, 2 tables restore-tested)");
  });

  test("a failed restore or different counts open backup-failed and drop the throwaway database", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bk-"));
    const ran: string[] = [];
    const run: Run = (cmd) => {
      ran.push(cmd[0]!);
      if (cmd[0] === "pg_dump") writeFileSync(cmd[cmd.length - 1]!, "dump");
      return { ok: true, err: "" };
    };
    const alerts: (string | null)[] = [];
    let n = 0;
    const r = await backup({ dir, databaseUrl: URL_, run, counts: async () => (n++ === 0 ? { pots: 3 } : { pots: 2 }), today: () => "2026-12-01", alert: async (p) => void alerts.push(p) });
    expect(r).toEqual({ ok: false, why: "The restored backup's row counts differ: pots: 3 live, 2 restored." });
    expect(alerts[0]).toContain("row counts differ");
    expect(ran.at(-1)).toBe("dropdb");
    expect(existsSync(join(dir, "last-good.json"))).toBe(false);
  });
});
