/**
 * The team bot's private data, read from TEAMBOT_DATA_DIR on the server (never from the repo:
 * the repo is public and none of these files are ever committed):
 *
 *   updates.json                         the updates (n, type, title, status, changelog, telegram, x, ...)
 *   config.json                          repo, explorer, contracts, socials, demo videos, health checks, roadmap image
 *   posters/square/update-NN-square.png  poster for Telegram
 *   posters/wide/update-NN-wide.png      poster for X
 *   state.json                           what has gone out (written by the bot, see state.ts)
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const updateSchema = z.object({
  n: z.number().int().positive(),
  type: z.string(),
  title: z.string(),
  status: z.string(),
  changelog: z.string().default(""),
  changelog_line: z.string().default(""),
  telegram: z.string(),
  x: z.string(),
});
export type Update = z.infer<typeof updateSchema>;

const configSchema = z.object({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).default("coferdev/cofer"),
  explorer: z.string().url(),
  roadmapImage: z.string().optional(),
  contracts: z.array(z.object({ name: z.string(), address: z.string().regex(/^0x[0-9a-fA-F]{40}$/), sourcify: z.boolean().optional() })),
  socials: z.array(z.object({ name: z.string(), url: z.string() })),
  videos: z.array(z.object({ title: z.string(), messageId: z.number().int(), fromChat: z.number().int().optional() })),
  health: z.array(z.object({ name: z.string(), url: z.string().url() })),
});
export type Config = z.infer<typeof configSchema>;

export type Shape = "square" | "wide";

/** Everything the team bot works from, loaded once at start. */
export interface Book {
  updates: Update[]; // sorted by n
  byN: Map<number, Update>;
  total: number;
  cfg: Config;
  repo: string;
  dataDir: string;
  slotMs: number; // one update per slot (60 minutes)
  catchupMs: number; // overdue updates after a pause go this far apart (2 minutes)
}

export const SLOT_MS = 60 * 60_000;
export const CATCHUP_MS = 2 * 60_000;

/** Builds the book from already-parsed JSON. Throws a plain message when a file is not as expected. */
export function makeBook(updatesJson: unknown, configJson: unknown, dataDir: string, o: { slotMs?: number; catchupMs?: number } = {}): Book {
  const u = z.array(updateSchema).safeParse(updatesJson);
  if (!u.success) throw new Error(`updates.json is not as expected (${u.error.issues[0]?.path.join(".")}: ${u.error.issues[0]?.message})`);
  const c = configSchema.safeParse(configJson);
  if (!c.success) throw new Error(`config.json is not as expected (${c.error.issues[0]?.path.join(".")}: ${c.error.issues[0]?.message})`);
  const updates = [...u.data].sort((a, b) => a.n - b.n);
  if (!updates.length) throw new Error("updates.json has no updates");
  const byN = new Map(updates.map((x) => [x.n, x]));
  if (byN.size !== updates.length) throw new Error("updates.json has the same update number twice");
  if (updates.some((x, i) => x.n !== i + 1)) throw new Error("updates.json must number its updates 1, 2, 3 ... with no gaps");
  return { updates, byN, total: updates.length, cfg: c.data, repo: c.data.repo, dataDir, slotMs: o.slotMs ?? SLOT_MS, catchupMs: o.catchupMs ?? CATCHUP_MS };
}

/** Reads updates.json and config.json from the data folder. */
export function loadBook(dataDir: string): Book {
  const read = (f: string) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dataDir, f), "utf8")) as unknown;
    } catch (e) {
      throw new Error(`${f} could not be read from the data folder (${e instanceof SyntaxError ? "not valid JSON" : "missing or not readable"})`);
    }
  };
  return makeBook(read("updates.json"), read("config.json"), dataDir);
}

export const pad = (n: number) => String(n).padStart(2, "0");
export const tag = (n: number) => `update-${pad(n)}`;
export const relUrl = (book: Book, n: number) => `https://github.com/${book.repo}/releases/tag/${tag(n)}`;
export const posterPath = (book: Book, n: number, shape: Shape) => path.join(book.dataDir, "posters", shape, `update-${pad(n)}-${shape}.png`);
/** The roadmap image, if config.json names one inside the data folder. */
export function roadmapPath(book: Book): string | null {
  if (!book.cfg.roadmapImage) return null;
  const p = path.resolve(book.dataDir, book.cfg.roadmapImage);
  const rel = path.relative(book.dataDir, p);
  return rel.startsWith("..") || path.isAbsolute(rel) ? null : p;
}
