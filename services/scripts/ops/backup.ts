/**
 * cofer-ops backup: the daily database backup (run by a systemd timer, docs/ops/backup.md).
 *   1. pg_dump of the whole database, custom format, into a private folder (mode 700), one file per UTC day;
 *   2. the backup is restored into a throwaway database, and every table's row count is compared with the live one;
 *   3. backups older than KEEP_DAYS are removed;
 *   4. on success, last-good.json records it (cofer-ops status shows it); on any failure, the staff alert
 *      "backup-failed" opens (it clears on the next good backup).
 * The connection details go to the Postgres tools as PG* environment variables, never on a command line (where any
 * user of the server could read them), and are never printed.
 *   cofer-ops backup --dir /var/backups/cofer
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const KEEP_DAYS = 14;
export const BACKUP_ALERT = "backup-failed";

/** PG* environment variables from a postgres:// URL (so nothing secret is on a command line). */
export function pgEnv(url: string): Record<string, string> {
  const u = new URL(url);
  const e: Record<string, string> = { PGHOST: u.hostname || "localhost", PGPORT: u.port || "5432", PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, "")) };
  if (u.username) e.PGUSER = decodeURIComponent(u.username);
  if (u.password) e.PGPASSWORD = decodeURIComponent(u.password);
  const ssl = u.searchParams.get("sslmode");
  if (ssl) e.PGSSLMODE = ssl;
  return e;
}

export const fileFor = (day: string) => `cofer-${day}.dump`;

/** The commands, in order (no connection detail in any of them). */
export function backupCommands(dir: string, day: string, scratch: string) {
  const file = join(dir, fileFor(day));
  return {
    file,
    dump: ["pg_dump", "--format=custom", "--no-owner", "--file", file],
    create: ["createdb", scratch],
    restore: ["pg_restore", "--no-owner", "--dbname", scratch, file],
    drop: ["dropdb", "--if-exists", scratch],
  };
}

/** The backup files to remove: those more than KEEP_DAYS days older than `today` (other files are left alone). */
export function expired(files: string[], today: string, keepDays = KEEP_DAYS): string[] {
  const cutoff = Date.parse(`${today}T00:00:00Z`) - (keepDays - 1) * 86_400_000;
  return files.filter((f) => {
    const m = /^cofer-(\d{4}-\d{2}-\d{2})\.dump$/.exec(f);
    return m ? Date.parse(`${m[1]}T00:00:00Z`) < cutoff : false;
  });
}

/** Tables whose row counts differ between the live database and the restored copy. */
export function countDifferences(live: Record<string, number>, restored: Record<string, number>): string[] {
  const out: string[] = [];
  for (const [t, n] of Object.entries(live)) if (restored[t] !== n) out.push(`${t}: ${n} live, ${restored[t] ?? "missing"} restored`);
  return out;
}

export type Run = (cmd: string[], env: Record<string, string>) => { ok: boolean; err: string };

export interface BackupDeps {
  dir: string;
  databaseUrl: string;
  run: Run;
  /** Row counts of every table in a database (the live one, or the scratch copy by name). */
  counts(database: string): Promise<Record<string, number>>;
  today(): string;
  alert(problem: string | null): Promise<void>;
}

export async function backup(d: BackupDeps): Promise<{ ok: true; file: string; tables: number; removed: string[] } | { ok: false; why: string }> {
  const day = d.today();
  const live = pgEnv(d.databaseUrl);
  const scratch = `cofer_restore_check_${day.replace(/-/g, "")}`;
  const c = backupCommands(d.dir, day, scratch);
  const fail = async (why: string) => {
    d.run(c.drop, live);
    await d.alert(why);
    return { ok: false as const, why };
  };
  mkdirSync(d.dir, { recursive: true, mode: 0o700 });
  chmodSync(d.dir, 0o700);
  const dump = d.run(c.dump, live);
  if (!dump.ok) return fail(`pg_dump failed (${dump.err.split("\n")[0]?.slice(0, 160)}).`);
  chmodSync(c.file, 0o600);
  d.run(c.drop, live);
  if (!d.run(c.create, live).ok) return fail("The throwaway database for the restore test could not be made.");
  const restore = d.run(c.restore, live);
  if (!restore.ok) return fail(`The backup could not be restored (${restore.err.split("\n")[0]?.slice(0, 160)}).`);
  const [liveCounts, restoredCounts] = await Promise.all([d.counts(live.PGDATABASE!), d.counts(scratch)]);
  const diff = countDifferences(liveCounts, restoredCounts);
  d.run(c.drop, live);
  if (diff.length) return fail(`The restored backup's row counts differ: ${diff.slice(0, 3).join("; ")}.`);
  const removed = expired(readdirSync(d.dir), day);
  for (const f of removed) rmSync(join(d.dir, f), { force: true });
  writeFileSync(join(d.dir, "last-good.json"), JSON.stringify({ day, file: fileFor(day), bytes: existsSync(c.file) ? statSync(c.file).size : 0, tables: Object.keys(liveCounts).length, at: new Date().toISOString() }));
  await d.alert(null);
  return { ok: true, file: c.file, tables: Object.keys(liveCounts).length, removed };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--dir");
  const dir = i >= 0 ? argv[i + 1]! : "/var/backups/cofer";
  const { env } = await import("../../src/env");
  const postgres = (await import("postgres")).default;
  const { checkAlert, alertDeps } = await import("../../src/keeper/alerts");
  const url = env().DATABASE_URL;
  const r = await backup({
    dir,
    databaseUrl: url,
    run: (cmd, e) => {
      const p = Bun.spawnSync(cmd, { env: { ...process.env, ...e }, stdout: "pipe", stderr: "pipe" });
      return { ok: p.exitCode === 0, err: p.stderr.toString() };
    },
    async counts(database) {
      const u = new URL(url);
      u.pathname = `/${database}`;
      // with no user in the URL, the system user, as the Postgres tools themselves do
      const user = u.username ? decodeURIComponent(u.username) : (process.env.PGUSER ?? process.env.USER ?? Bun.spawnSync(["id", "-un"]).stdout.toString().trim());
      const sql = postgres(u.toString(), { max: 1, onnotice: () => {}, username: user });
      try {
        const tables = (await sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`).map((t) => t.table_name as string);
        const out: Record<string, number> = {};
        for (const t of tables) out[t] = Number((await sql.unsafe(`select count(*)::int as n from "${t.replace(/"/g, "")}"`))[0]!.n);
        return out;
      } finally {
        await sql.end();
      }
    },
    today: () => new Date().toISOString().slice(0, 10),
    alert: async (problem) => void (await checkAlert(BACKUP_ALERT, problem === null ? null : { name: BACKUP_ALERT, what: `Today's database backup failed: ${problem}`, who: "Dev checks the server (disk space, Postgres tools)." }, alertDeps(), "today's backup was made and restored")),
  });
  console.log(r.ok ? `Backup made and restore-tested: ${r.file} (${r.tables} tables match)${r.removed.length ? `; removed ${r.removed.length} old backup(s)` : ""}.` : `Backup FAILED: ${r.why}`);
  process.exit(r.ok ? 0 : 1);
}
