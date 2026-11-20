/**
 * The Arena indexer process (its own systemd unit, testnet first).
 *   bun src/arena/indexer/main.ts [--once]
 * Refuses to start on a chain without Arena contracts (mainnet until its deploy) or with the feature off.
 */
import postgres from "postgres";
import { createPublicClient, http } from "viem";
import { arenaContracts } from "../chain/contracts";
import { arenaEnv } from "../env";
import { arenaEnabled } from "../flags";
import { migrateArena } from "../db/migrate";
import { indexArenaOnce, viemReader } from "./indexer";
import { logError } from "../../core/errors";

export function startProblem(e: ReturnType<typeof arenaEnv>, src: Record<string, string | undefined> = process.env): string | null {
  if (!arenaContracts(e.CHAIN_ID)) return `no Arena contracts on chain ${e.CHAIN_ID}`;
  if (!arenaEnabled("app", { ...src, CHAIN_ID: String(e.CHAIN_ID) })) return `the Arena "app" feature is off on chain ${e.CHAIN_ID}`;
  return null;
}

if (import.meta.main) {
  const e = arenaEnv();
  const why = startProblem(e);
  if (why) {
    console.log(`arena indexer not started: ${why}`);
    process.exit(0);
  }
  const c = arenaContracts(e.CHAIN_ID)!;
  const sql = postgres(e.DATABASE_URL, { max: 2, onnotice: () => {} });
  const applied = await migrateArena(sql);
  if (applied.length) console.log(`arena tables: applied ${applied.join(", ")}`);
  const client = createPublicClient({ transport: http(e.RHC_RPC_URL) });
  const chain = viemReader(client as never);
  const once = process.argv.includes("--once");
  let stop = false;
  for (const s of ["SIGINT", "SIGTERM"] as const) process.on(s, () => (stop = true));
  console.log(`arena indexer: chain ${e.CHAIN_ID}, factory ${c.factory}`);
  while (!stop) {
    let r: Awaited<ReturnType<typeof indexArenaOnce>> = null;
    try {
      r = await indexArenaOnce(sql, chain, c, e.ARENA_CONFIRMATIONS);
      if (r && r.logs) console.log(`blocks ${r.from}-${r.to}: ${r.logs} logs, ${r.applied} applied`);
    } catch (err) {
      logError("arena-indexer", err);
    }
    if (once && !r) break;
    if (!r) await Bun.sleep(e.ARENA_POLL_MS);
  }
  await sql.end();
}
