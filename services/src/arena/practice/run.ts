/**
 * Runs one Practice game on the live tape, with practice bots at the table, and writes its log and summary.
 *   bun src/arena/practice/run.ts --tape <dir> [--minutes 15] [--bots 3] [--out <dir>] [--chain 46630] [--id <id>]
 * Then anyone can check it:  bun tools/arena-replay/arena-replay.ts verify-practice --log <out>/practice-<id>.log --tape <dir>
 * Reads the tape only; no keys, no chain, no database.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TapeFollower } from "../marks/follow";
import { PracticeBot } from "./bots";
import { PracticeGame, practiceRules, practiceTable } from "./practice";

const arg = (k: string, d?: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};

export function summaryJson(game: PracticeGame, id: string, botCount: number) {
  const r = game.close();
  return {
    id, mode: "PRACTICE", chainId: game.open.chainId, table: r.table, head: r.head, rulesHash: game.open.rulesHash,
    startAt: new Date(game.open.lockedAt).toISOString(), endAt: new Date(game.open.endAt).toISOString(), tapeHours: game.open.tapeHours,
    seats: game.open.seats, bots: botCount, ticks: game.ticks, events: r.log.length,
    standings: r.standings.map((s) => ({ rank: s.rank, seat: s.seat, finalEquity: s.finalEquity.toString(), maxDrawdownBps: s.maxDrawdownBps.toString(), score1e6: s.score1e6.toString(), activityOk: s.activityOk, eliminatedAt: s.eliminatedAt ?? null })),
  };
}

if (import.meta.main) {
  const tape = arg("tape");
  if (!tape) throw new Error("--tape <dir> is required (the marks service's tape directory)");
  const minutes = Number(arg("minutes", "15"));
  const nBots = Number(arg("bots", "3"));
  const out = arg("out", "./practice")!;
  const chainId = Number(arg("chain", "46630"));
  const id = arg("id", crypto.randomUUID())!;
  mkdirSync(out, { recursive: true });

  const table = practiceTable(id);
  const bots = Array.from({ length: nBots }, (_, i) => new PracticeBot(id, i, table));
  const startAt = Math.ceil(Date.now() / 1000) * 1000 + 3000;
  const game = new PracticeGame({ chainId, id, rules: practiceRules("cofer-arena-engine"), seats: bots.map((b) => b.seat), startAt, durationMs: minutes * 60_000 });
  console.log(`practice ${id}: table ${table}, ${nBots} bots, ${new Date(startAt).toISOString()} to ${new Date(game.open.endAt).toISOString()}`);

  let refused = 0;
  const follower = new TapeFollower(tape, (ts, marks) => {
    game.tick(ts, marks);
    if (game.finished || ts < startAt) return;
    for (const b of bots) for (const o of b.afterTick()) if (!game.place(o.bytes, o.sig).ok) refused++;
    if (game.ticks % 60 === 0) console.log(`${new Date(ts).toISOString()} minute ${game.ticks / 60}, board: ${game.host.board(3).map((s) => `${s.seat.slice(0, 8)} ${Number(s.finalEquity) / 1e6}`).join(" | ")}`);
  }, Date.now(), true);

  let lastTickAt = Date.now();
  while (!game.finished) {
    if (follower.poll() > 0) lastTickAt = Date.now();
    if (Date.now() - lastTickAt > 120_000) throw new Error("no tape ticks for 2 minutes: is the marks service running?");
    if (Date.now() > game.open.endAt + 120_000) game.close(); // the tape stopped right at the end
    await Bun.sleep(200);
  }
  const s = summaryJson(game, id, nBots);
  const r = game.close();
  writeFileSync(join(out, `practice-${id}.log`), `${r.log.join("\n")}\n`);
  writeFileSync(join(out, `practice-${id}.json`), `${JSON.stringify(s, null, 2)}\n`);
  console.log(`finished: ${s.ticks} ticks, ${s.events} events, ${refused} orders refused, head ${s.head}`);
  for (const x of s.standings) console.log(`  ${x.rank}. ${x.seat}  ${(Number(x.finalEquity) / 1e6).toFixed(2)}`);
  console.log(`check it: bun tools/arena-replay/arena-replay.ts verify-practice --log ${join(out, `practice-${id}.log`)} --tape ${tape} --head ${s.head}`);
}
