/**
 * The marks process (spec §5.2): source adapters -> tape writer -> one tick per UTC second.
 * Writes each hour's tape as NDJSON (one encoded event per line); when the hour closes it writes the head and
 * gzips the hour (about 14 MB an hour gzipped).
 *
 *   bun src/arena/marks/main.ts --out <dir> [--chain 4663|46630] [--rpc <url>] [--minutes N] [--quiet]
 *                               [--keep-days 30] [--min-free-gb 10]
 *
 * Disk: each closed hour is gzipped (about 14 MB); hours older than --keep-days are deleted when an hour closes; if
 * the disk's free space falls under --min-free-gb, the tape stops being written (marks still run) and it says so
 * once a minute, so the tape can never fill the disk.
 *
 * Public data only: no keys, no database writes. The Redis stream, the database sink and the active/standby lock
 * are added with the engine (ROLE=marks in src/index.ts after the hourly updates finish).
 */
import { mkdirSync, appendFileSync, writeFileSync, readFileSync, unlinkSync, existsSync, readdirSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http, type Address } from "viem";
import { fetchCanonicalStocks } from "../../stocks/canonical";
import { STOCK_API } from "../../chain/addresses";
import { SYMBOLS, MARKETS, type Symbol } from "./markets";
import { startLighter } from "./lighter";
import { startArcus } from "./arcus";
import { startChainlink } from "./chainlink";
import { TapeWriter, type EncodedEvent } from "./tape";
import type { Mark, Quote } from "./median";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
}

const out = arg("out") ?? "./tape";
const chainId = Number(arg("chain", "4663"));
const rpc = arg("rpc", "https://rpc.mainnet.chain.robinhood.com")!;
const minutes = Number(arg("minutes", "0"));
const quiet = process.argv.includes("--quiet");
const keepDays = Number(arg("keep-days", "30"));
const minFreeBytes = Number(arg("min-free-gb", "10")) * 1024 ** 3;
mkdirSync(out, { recursive: true });

const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

let diskLow = false;
const checkDisk = () => {
  try {
    const f = statfsSync(out);
    const free = Number(f.bavail) * Number(f.bsize);
    diskLow = free < minFreeBytes;
    if (diskLow) log(`disk low: ${(free / 1024 ** 3).toFixed(1)} GB free, under ${minFreeBytes / 1024 ** 3} GB: the tape is not being written`);
  } catch (e) {
    log(`disk check failed: ${String(e).slice(0, 80)}`);
  }
};
checkDisk();
setInterval(checkDisk, 60_000);

/** Delete closed hours older than keepDays (their gz file and head). */
const prune = (closedHour: number) => {
  const oldest = closedHour - keepDays * 24;
  for (const f of readdirSync(out)) {
    const m = /^tape-(\d+)\.(ndjson\.gz|head)$/.exec(f);
    if (m && Number(m[1]) < oldest) unlinkSync(join(out, f));
  }
};

const sink = (e: EncodedEvent) => {
  if (diskLow) return;
  appendFileSync(join(out, `tape-${e.hourId}.ndjson`), JSON.stringify({ seq: e.seq, kind: e.kind, encoded: e.encoded, chainHash: e.chainHash }) + "\n");
};
const onHourClosed = (hourId: number, head: string, n: number) => {
  writeFileSync(join(out, `tape-${hourId}.head`), `${head}\n`);
  const raw = join(out, `tape-${hourId}.ndjson`);
  if (existsSync(raw)) {
    writeFileSync(`${raw}.gz`, Bun.gzipSync(readFileSync(raw)));
    unlinkSync(raw);
  }
  prune(hourId);
  log(`hour ${hourId} closed: ${n} events, tapeHead ${head}`);
};
const tape = new TapeWriter(chainId, sink, onHourClosed);

let quotes = 0;
const onQuote = (q: Quote) => {
  quotes++;
  tape.quote(q);
};

const stocks = await fetchCanonicalStocks(STOCK_API, 4663).catch((e) => {
  log(`stock list failed (${String(e).slice(0, 80)}); Chainlink stock prices off`);
  return [];
});
const tokens: Partial<Record<Symbol, Address>> = {};
for (const s of SYMBOLS) if (MARKETS[s].cls === "stock") {
  const hit = stocks.find((x) => x.symbol === s);
  if (hit) tokens[s] = hit.address;
}

const client = createPublicClient({ transport: http(rpc, { timeout: 2_500 }) });
const handles = [
  startLighter(SYMBOLS, onQuote, log),
  startArcus(onQuote, log),
  startChainlink({ client: client as never, symbols: SYMBOLS, tokens }, onQuote, log),
];

const fmt = (m: Mark) => {
  if (m.mark === null) return `${m.symbol} ${m.status}`;
  const s = m.mark.toString().padStart(9, "0");
  return `${m.symbol} ${s.slice(0, -8)}.${s.slice(-8, -6)} (${m.used.length})`;
};

let ticks = 0;
const tickLoop = () => {
  const now = Date.now();
  const next = Math.floor(now / 1000) * 1000 + 1000;
  setTimeout(() => {
    const marks = tape.tick(next);
    ticks++;
    if (!quiet && ticks % 10 === 0) log(`tick ${ticks} · ${marks.map(fmt).join(" · ")} · quotes ${quotes}`);
    tickLoop();
  }, next - now);
};
log(`marks on chain ${chainId}: ${SYMBOLS.join(", ")}; writing to ${out}`);
tickLoop();

const stop = () => {
  for (const h of handles) h.stop();
  const f = tape.flush();
  if (f) writeFileSync(join(out, `tape-${f.hourId}.partial-head`), `${f.tapeHead}\n`);
  log("stopped");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
if (minutes > 0) setTimeout(stop, minutes * 60_000);
