#!/usr/bin/env bun
/**
 * arena-replay: check any Arena game yourself, from public data only (spec §4.8). MIT licensed.
 *
 *   bun tools/arena-replay/arena-replay.ts verify <table> [--rpc <url>] [--log <file|https|ipfs uri>] [--tape <dir|uri>]
 *        [--engine-build 0x…] [--payouts <rows.json>] [--from-block N] [--no-quotes]
 *     PASS/FAIL per step (chain, tape, quotes, keys, replay, result); exit 0 only if nothing failed.
 *   bun tools/arena-replay/arena-replay.ts me <table> --seat <addr> [same options]
 *     your equity curve (CSV, one row a minute), fills, rejections with reasons, and your drawdown.
 *
 * A log is one hex event per line (or NDJSON with an "encoded" field). A tape directory holds
 * tape-<hour>.ndjson or tape-<hour>.ndjson.gz, one file per UTC hour, as the marks service writes them.
 * Nothing here needs a key: the RPC is only read.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeLogEvent } from "../../services/src/arena/log/events";
import { parseRules, type RulesJson } from "../../services/src/arena/engine/rules";
import { replayLog } from "../../services/src/arena/log/record";
import { checkChainlink, publicClient, readGame } from "../../services/src/arena/replay/chainRead";
import { chainlinkQuotes, ticksFromTape, verifyGame } from "../../services/src/arena/replay/verifyGame";

type Hex = `0x${string}`;
const DEFAULT_RPC = "https://rpc.mainnet.chain.robinhood.com";
const argv = process.argv.slice(2);
const opt = (k: string) => {
  const i = argv.indexOf(`--${k}`);
  return i > 0 ? argv[i + 1] : undefined;
};
const [cmd, table] = argv as [string?, string?];
if ((cmd !== "verify" && cmd !== "me") || !table || !/^0x[0-9a-fA-F]{40}$/.test(table) || (cmd === "me" && !opt("seat"))) {
  console.log("usage: arena-replay verify <table> [--rpc url] [--log uri] [--tape dir|uri] [--engine-build 0x..] [--payouts rows.json]");
  console.log("       arena-replay me <table> --seat <addr> [same options]");
  process.exit(2);
}

async function fetchText(uri: string): Promise<string> {
  const gz = uri.endsWith(".gz");
  let bytes: Uint8Array;
  if (/^https?:\/\//.test(uri) || uri.startsWith("ipfs://")) {
    const url = uri.startsWith("ipfs://") ? `https://ipfs.io/ipfs/${uri.slice(7)}` : uri;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    bytes = new Uint8Array(await r.arrayBuffer());
  } else bytes = new Uint8Array(readFileSync(uri));
  return new TextDecoder().decode(gz ? Bun.gunzipSync(bytes) : bytes);
}
const lines = (text: string): Hex[] =>
  text.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => (l.startsWith("0x") ? (l as Hex) : (JSON.parse(l).encoded as Hex)));

async function tapeHour(base: string, h: number): Promise<Hex[] | undefined> {
  for (const name of [`tape-${h}.ndjson`, `tape-${h}.ndjson.gz`]) {
    const p = /^(https?|ipfs):\/\//.test(base) ? `${base.replace(/\/$/, "")}/${name}` : join(base, name);
    if (!/^(https?|ipfs):\/\//.test(base) && !existsSync(p)) continue;
    try {
      return lines(await fetchText(p));
    } catch {
      /* try the next name */
    }
  }
  return undefined;
}

process.on("uncaughtException", (e) => fail(e));
process.on("unhandledRejection", (e) => fail(e));
function fail(e: unknown): never {
  const m = (e as { shortMessage?: string }).shortMessage ?? String((e as Error).message ?? e);
  console.log(`FAIL ${m.split("\n")[0]}`);
  process.exit(1);
}

const client = publicClient(opt("rpc") ?? DEFAULT_RPC);
const t = table as Hex;

// the log first: it names the tape hours the game used
const pre = await readGame(client, t, [], BigInt(opt("from-block") ?? "0"));
const log = lines(await fetchText(opt("log") ?? pre.posted.logURI));
const open = decodeLogEvent(log[0]!);
const hours = open.type === "GameOpen" ? (open.payload[8] as bigint[]).map(Number) : [];
const game = await readGame(client, t, hours, BigInt(opt("from-block") ?? "0"));
const tapeBase = opt("tape");
const tape = new Map<number, Hex[]>();
if (tapeBase) for (const h of hours) {
  const x = await tapeHour(tapeBase, h);
  if (x) tape.set(h, x);
}
const payouts = opt("payouts")
  ? (JSON.parse(readFileSync(opt("payouts")!, "utf8")) as { index: number; account: Hex; amount: string }[]).map((r) => ({ ...r, amount: BigInt(r.amount) }))
  : undefined;
const quoteProblems = argv.includes("--no-quotes") ? undefined : await checkChainlink(client, chainlinkQuotes(tape.values()));

if (cmd === "verify") {
  const out = verifyGame(game, { log, tape, payouts, engineBuild: opt("engine-build") as Hex | undefined, quoteProblems });
  console.log(`arena-replay verify ${t} on chain ${game.chainId}, result round ${game.posted.round}`);
  out.steps.forEach((s, i) => {
    console.log(`${i + 1}. ${s.status.padEnd(4)} ${s.name}: ${s.detail[0]}`);
    for (const d of s.detail.slice(1)) console.log(`         ${d}`);
  });
  console.log(out.ok ? "PASS" : "FAIL");
  process.exit(out.ok ? 0 : 1);
}

// me: replay with an observer on one seat
const seat = opt("seat")!.toLowerCase();
if (open.type !== "GameOpen") (console.log("the log does not start with GameOpen"), process.exit(1));
const rules = parseRules(JSON.parse(open.payload[2] as string) as RulesJson);
const ticks = ticksFromTape(tape.values());
const curve: string[] = ["minute_utc,equity_chips"];
let maxDdBps = 0n;
const fills: string[] = [];
const rejects: string[] = [];
replayLog(game.chainId, log, rules, (ts) => ticks.get(ts), undefined, undefined, [], {
  emitted: (e) => {
    if (!("seat" in e) || e.seat !== seat) return;
    if (e.t === "Fill") fills.push(`${new Date(e.ts).toISOString()} ${e.symbol} ${e.product} ${e.dq} @ ${e.px} fee ${e.fee}`);
    if (e.t === "Reject") rejects.push(`${e.clientId}: ${e.reason}`);
  },
  tick: (ts, g) => {
    const s = g.samples.get(seat);
    if (s) {
      maxDdBps = s.maxDdBps;
      if (ts % 60_000 === 0) curve.push(`${new Date(ts).toISOString()},${s.lastEquity}`);
    }
  },
});
console.log(curve.join("\n"));
console.log(`\nfills (${fills.length})\n${fills.join("\n")}`);
console.log(`\nrejections (${rejects.length})\n${rejects.join("\n")}`);
console.log(`\nlargest drawdown: ${Number(maxDdBps) / 100}%`);
