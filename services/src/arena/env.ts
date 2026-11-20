/**
 * Settings for the Arena processes (marks, indexer, engine, arena-ws, ...). Each reads only what it needs, from its
 * own environment file, so an Arena process never holds the group services' keys.
 */
import { z } from "zod";

const base = z.object({
  CHAIN_ID: z.coerce.number().int(),
  DATABASE_URL: z.string().min(1),
  RHC_RPC_URL: z.string().url(),
  ARENA_FEATURES: z.string().default(""),
  ARENA_FEATURES_MAINNET: z.string().default(""),
  ARENA_CONFIRMATIONS: z.coerce.number().int().min(0).default(20),
  ARENA_POLL_MS: z.coerce.number().int().min(250).default(2_000),
});
export type ArenaEnv = z.infer<typeof base>;

export function arenaEnv(src: Record<string, string | undefined> = process.env): ArenaEnv {
  const r = base.safeParse(src);
  if (!r.success) throw new Error(`arena settings: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return r.data;
}
