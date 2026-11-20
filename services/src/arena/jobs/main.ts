/**
 * The Arena table jobs process (its own systemd unit, testnet first): every ARENA_SWEEP_MS, lock / cancel /
 * finalize / refundAll whatever is due, from a gas-only key (ARENA_RELAYER_KEY, made on the server, never printed).
 *   bun src/arena/jobs/main.ts [--once]
 * Refuses to start on a chain without Arena contracts (mainnet until its deploy) or with the feature off.
 */
import postgres from "postgres";
import { type Address, type Hex, createPublicClient, createWalletClient, defineChain, formatEther, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { arenaContracts } from "../chain/contracts";
import { readTable } from "../chain/tableView";
import { arenaEnv } from "../env";
import { startProblem } from "../indexer/main";
import { logError } from "../../core/errors";
import { makeRelayer } from "./relay";
import { sweepOnce } from "./sweep";

export const LIVE_STATES = ["open", "locked", "settling", "disputed"] as const;
export const RELAYER_LOW_ETH = 2_000_000_000_000_000n; // 0.002: the log says so below this

const extra = z.object({
  ARENA_RELAYER_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "ARENA_RELAYER_KEY must be a 0x-prefixed 32-byte key"),
  ARENA_SWEEP_MS: z.coerce.number().int().min(1_000).default(5_000),
});

if (import.meta.main) {
  const e = arenaEnv();
  const why = startProblem(e);
  if (why) {
    console.log(`arena jobs not started: ${why}`);
    process.exit(0);
  }
  const x = extra.safeParse(process.env);
  if (!x.success) throw new Error(`arena jobs settings: ${x.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const c = arenaContracts(e.CHAIN_ID)!;
  const chain = defineChain({ id: e.CHAIN_ID, name: `chain ${e.CHAIN_ID}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [e.RHC_RPC_URL] } } });
  const pub = createPublicClient({ chain, transport: http(e.RHC_RPC_URL) });
  if ((await pub.getChainId()) !== e.CHAIN_ID) throw new Error(`the RPC is not chain ${e.CHAIN_ID}`);
  const account = privateKeyToAccount(x.data.ARENA_RELAYER_KEY as Hex);
  const wallet = createWalletClient({ account, chain, transport: http(e.RHC_RPC_URL) });
  const sql = postgres(e.DATABASE_URL, { max: 2, onnotice: () => {} });
  const relay = makeRelayer(pub, wallet);
  console.log(`arena jobs: chain ${e.CHAIN_ID}, factory ${c.factory}, relayer ${account.address}`);
  const once = process.argv.includes("--once");
  let stop = false;
  for (const s of ["SIGINT", "SIGTERM"] as const) process.on(s, () => (stop = true));
  let lastBalanceCheck = 0;
  const noEngine = new Set<string>();
  while (!stop) {
    try {
      if (Date.now() - lastBalanceCheck > 600_000) {
        lastBalanceCheck = Date.now();
        const bal = await pub.getBalance({ address: account.address });
        if (bal < RELAYER_LOW_ETH) console.log(`arena jobs: relayer gas is low (${formatEther(bal)} ETH at ${account.address})`);
      }
      const items = await sweepOnce({
        liveTables: async () => (await sql`SELECT address FROM arena_tables WHERE state IN ${sql([...LIVE_STATES])} AND address NOT LIKE 'practice:%'`).map((r) => r.address as Address),
        view: (t) => readTable(pub, t),
        chainNow: async () => Number((await pub.getBlock()).timestamp),
        relay,
        log: (l) => console.log(`arena jobs: ${l}`),
      });
      for (const i of items) {
        if (i.outcome === "no-engine" && !noEngine.has(i.table)) {
          noEngine.add(i.table);
          console.log(`arena jobs: ${i.table}: the game has ended; no engine runs on this chain yet, so it settles by the deadline refund`);
        }
      }
    } catch (err) {
      logError("arena-jobs", err);
    }
    if (once) break;
    await Bun.sleep(x.data.ARENA_SWEEP_MS);
  }
  await sql.end();
}
