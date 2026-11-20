/**
 * The App's server process (its own systemd unit, testnet first).
 *   bun src/arena/app/main.ts
 * Settings (its own environment file): CHAIN_ID, DATABASE_URL, ARENA_FEATURES (needs "app"; "practice" turns on
 * instant Practice games), ARENA_LINK_SECRET, ARENA_APP_ORIGIN, ARENA_APP_PORT, ARENA_TAPE_DIR, ARENA_PRACTICE_DIR,
 * ARENA_APP_DIST. Refuses to start with the "app" feature off (on mainnet that is the default).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { z } from "zod";
import { logError } from "../../core/errors";
import { migrateArena } from "../db/migrate";
import { arenaEnabled } from "../flags";
import { TapeFollower } from "../marks/follow";
import { PracticeHub } from "./practiceHub";
import { makeAppServer } from "./server";
import { wire } from "./seatView";

const schema = z.object({
  CHAIN_ID: z.coerce.number().int(),
  DATABASE_URL: z.string().min(1),
  ARENA_LINK_SECRET: z.string().min(32),
  ARENA_APP_ORIGIN: z.string().url().refine((u) => new URL(u).origin === u, "an origin, like https://host with no path"),
  ARENA_APP_PORT: z.coerce.number().int().min(1).max(65535).default(8450),
  ARENA_TAPE_DIR: z.string().min(1),
  ARENA_PRACTICE_DIR: z.string().min(1),
  ARENA_APP_DIST: z.string().default(""),
});

export function appStartProblem(src: Record<string, string | undefined> = process.env): string | null {
  if (!arenaEnabled("app", src)) return `the Arena "app" feature is off on chain ${src.CHAIN_ID}`;
  return null;
}

export function buildHash(dist: string): string {
  const f = join(dist, "index.html");
  return existsSync(f) ? createHash("sha256").update(readFileSync(f)).digest("hex").slice(0, 16) : "none";
}

if (import.meta.main) {
  const why = appStartProblem();
  if (why) {
    console.log(`arena app not started: ${why}`);
    process.exit(0);
  }
  const r = schema.safeParse(process.env);
  if (!r.success) throw new Error(`arena app settings: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const e = r.data;
  const sql = postgres(e.DATABASE_URL, { max: 2, onnotice: () => {} });
  const applied = await migrateArena(sql);
  if (applied.length) console.log(`arena tables: applied ${applied.join(", ")}`);

  let publish: (room: string, msg: string) => void = () => {};
  const practice = arenaEnabled("practice");
  const hub = practice
    ? new PracticeHub({ chainId: e.CHAIN_ID, outDir: e.ARENA_PRACTICE_DIR, tapeDir: e.ARENA_TAPE_DIR, send: (room, ev, data) => publish(room, wire({ op: "ev", room, ev, data })) })
    : null;
  const dist = e.ARENA_APP_DIST || null;
  const app = makeAppServer({
    hub, secret: e.ARENA_LINK_SECRET, origin: e.ARENA_APP_ORIGIN, appDist: dist, build: dist ? buildHash(dist) : "none", chainId: e.CHAIN_ID,
    useJti: async (jti, tg, exp) => {
      const rows = await sql`INSERT INTO arena_used_links (jti, tg, expires_at) VALUES (${jti}, ${tg}, to_timestamp(${exp})) ON CONFLICT (jti) DO NOTHING RETURNING jti`;
      return rows.length === 1;
    },
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: e.ARENA_APP_PORT, fetch: app.fetch, websocket: app.websocket });
  publish = (room, msg) => void server.publish(room, msg);
  console.log(`arena app: chain ${e.CHAIN_ID}, 127.0.0.1:${e.ARENA_APP_PORT}, origin ${e.ARENA_APP_ORIGIN}, practice ${practice ? "on" : "off"}, build ${dist ? buildHash(dist) : "none"}`);

  if (hub) {
    const follower = new TapeFollower(e.ARENA_TAPE_DIR, (ts, marks) => hub.tick(ts, marks), Date.now(), true);
    setInterval(() => {
      try {
        follower.poll();
      } catch (err) {
        logError("arena-app", err);
      }
    }, 200);
    setInterval(() => hub.housekeep(), 10_000);
  }
  setInterval(() => void sql`DELETE FROM arena_used_links WHERE expires_at < now() - interval '1 day'`.catch((err) => logError("arena-app", err)), 3_600_000);
  for (const s of ["SIGINT", "SIGTERM"] as const) process.on(s, () => {
    server.stop();
    void sql.end().then(() => process.exit(0));
  });
}
