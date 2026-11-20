/**
 * Applies drizzle-arena/*.sql in name order, each once, inside one transaction under an advisory lock, and records
 * it in arena_migrations. A file already applied is skipped; a changed file (different sha256) stops everything.
 *   bun src/arena/db/migrate.ts            (DATABASE_URL from the environment)
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

export const ARENA_MIGRATIONS = join(import.meta.dir, "../../../drizzle-arena");
const LOCK = 46_630_001; // advisory lock id for this runner

export async function migrateArena(sql: postgres.Sql, dir = ARENA_MIGRATIONS): Promise<string[]> {
  const files = readdirSync(dir).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
  const applied: string[] = [];
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${LOCK})`;
    await tx`CREATE TABLE IF NOT EXISTS arena_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`;
    const done = new Map((await tx`SELECT name, sha256 FROM arena_migrations`).map((r) => [r.name as string, r.sha256 as string]));
    for (const f of files) {
      const body = readFileSync(join(dir, f), "utf8");
      const sha = createHash("sha256").update(body).digest("hex");
      const had = done.get(f);
      if (had === sha) continue;
      if (had) throw new Error(`arena migration ${f} changed after it was applied`);
      await tx.unsafe(body);
      await tx`INSERT INTO arena_migrations (name, sha256) VALUES (${f}, ${sha})`;
      applied.push(f);
    }
  });
  return applied;
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const applied = await migrateArena(sql);
  console.log(applied.length ? `applied: ${applied.join(", ")}` : "arena tables up to date");
  await sql.end();
}
