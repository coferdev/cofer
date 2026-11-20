import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { Hex } from "viem";
import { TapeFollower } from "../src/arena/marks/follow";
import { HOUR_MS } from "../src/arena/marks/tape";
import { decodeLogEvent, encodeLogEvent } from "../src/arena/log/events";
import { PracticeBot } from "../src/arena/practice/bots";
import { PracticeGame, practiceRules, practiceTable } from "../src/arena/practice/practice";
import { verifyPractice } from "../src/arena/replay/verifyPractice";
import { liveTape as liveTapeAt } from "./arenaTapeFixture";

const PX = (n: number) => BigInt(Math.round(n * 1e8));
const CHAIN = 46630;
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const liveTape = (startMs: number) => liveTapeAt(startMs, CHAIN, dirs);

function play(o: { id: string; startMs: number; seconds: number; bots: number; chunk?: number; gzipMidway?: boolean }) {
  const tape = liveTape(o.startMs);
  const table = practiceTable(o.id);
  const bots = Array.from({ length: o.bots }, (_, i) => new PracticeBot(o.id, i, table));
  let lastTick = 0;
  const startAt = o.startMs + 2000;
  const game = new PracticeGame({ chainId: CHAIN, id: o.id, rules: practiceRules("test"), seats: bots.map((b) => b.seat), startAt, durationMs: o.seconds * 1000, now: () => lastTick + 40, allowShort: true });
  let placed = 0;
  let refused = 0;
  const f = new TapeFollower(tape.dir, (ts, marks) => {
    lastTick = ts;
    game.tick(ts, marks);
    if (game.finished || ts < startAt) return;
    for (const b of bots) for (const x of b.afterTick()) (game.place(x.bytes, x.sig).ok ? placed++ : refused++);
  }, o.startMs);
  // the tape grows a chunk at a time, as it does live, and the game follows it
  for (let written = 0; !game.finished && written < o.seconds + 30; written += o.chunk ?? 7) {
    tape.write(o.chunk ?? 7);
    f.poll(o.startMs + (written + (o.chunk ?? 7)) * 1000 + 1500);
  }
  return { game, tape, bots, placed, refused, result: game.close() };
}

function loadTape(dir: string, hours: number[]) {
  const tape = new Map<number, Hex[]>();
  const heads = new Map<number, Hex>();
  for (const h of hours) {
    const raw = join(dir, `tape-${h}.ndjson`);
    const text = existsSync(raw) ? readFileSync(raw, "utf8") : new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(readFileSync(`${raw}.gz`))));
    tape.set(h, text.split("\n").filter(Boolean).map((l) => JSON.parse(l).encoded as Hex));
    if (existsSync(join(dir, `tape-${h}.head`))) heads.set(h, readFileSync(join(dir, `tape-${h}.head`), "utf8").trim() as Hex);
  }
  return { tape, heads };
}

describe("Practice end to end", () => {
  const start = Date.parse("2026-11-21T09:56:00Z"); // the game crosses 10:00, so the tape changes hour mid-game
  const run = play({ id: "e2e-1", startMs: start, seconds: 300, bots: 3 });

  test("the game ran on the tape's ticks, the bots traded, and it closed with standings", () => {
    expect(run.game.ticks).toBe(300); // one tick a second, from startAt up to (not including) endAt
    expect(run.placed).toBeGreaterThanOrEqual(8);
    expect(run.refused).toBe(0);
    expect(run.result.standings.map((s) => s.rank)).toEqual([1, 2, 3]);
    expect(run.game.open.tapeHours.length).toBe(2);
    const types = run.result.log.map((e) => decodeLogEvent(e).type);
    expect(types[0]).toBe("GameOpen");
    expect(types.at(-1)).toBe("GameClose");
    expect(types.filter((t) => t === "Fill").length).toBeGreaterThanOrEqual(8);
  });

  test("anyone can check it from the log and the tape alone: rules, tape and replay PASS, same head and standings", () => {
    const { tape, heads } = loadTape(run.tape.dir, run.game.open.tapeHours);
    expect(heads.size).toBe(1); // the first hour has closed and published its head; the second is still open
    const c = verifyPractice(CHAIN, run.result.log, tape, heads, run.result.head);
    expect(c.steps.map((s) => [s.name, s.status])).toEqual([["rules", "PASS"], ["tape", "PASS"], ["replay", "PASS"]]);
    expect(c.head).toBe(run.result.head);
    expect(c.standings).toEqual(run.result.standings);
  });

  test("the replay tool says the same from files", () => {
    const out = mkdtempSync(join(tmpdir(), "arena-practice-out-"));
    dirs.push(out);
    writeFileSync(join(out, "game.log"), `${run.result.log.join("\n")}\n`);
    const r = spawnSync(process.execPath, [join(import.meta.dir, "../../tools/arena-replay/arena-replay.ts"), "verify-practice", "--log", join(out, "game.log"), "--tape", run.tape.dir, "--head", run.result.head], { encoding: "utf8" });
    expect(r.stdout).toContain("1. PASS rules");
    expect(r.stdout).toContain("2. PASS tape");
    expect(r.stdout).toContain("3. PASS replay");
    expect(r.stdout.trim().split("\n").at(-1)).toBe("PASS");
    expect(r.status).toBe(0);
  });

  test("each kind of tampering fails its own step", () => {
    const { tape, heads } = loadTape(run.tape.dir, run.game.open.tapeHours);
    const steps = (log: Hex[], t = tape, h = heads, head: Hex | undefined = run.result.head) => Object.fromEntries(verifyPractice(CHAIN, log, t, h, head).steps.map((s) => [s.name, s.status]));

    // a fill price changed in the published log
    const i = run.result.log.findIndex((e) => decodeLogEvent(e).type === "Fill");
    const f = decodeLogEvent(run.result.log[i]!);
    const p = [...f.payload];
    p[5] = (p[5] as bigint) + 1n;
    const log = [...run.result.log];
    log[i] = encodeLogEvent({ ...f, payload: p });
    expect(steps(log).replay).toBe("FAIL");

    // a tape line changed (the hash chain breaks)
    const [h0] = run.game.open.tapeHours;
    const bad = new Map(tape);
    const lines = [...bad.get(h0!)!];
    lines.splice(5, 1);
    bad.set(h0!, lines);
    expect(steps(run.result.log, bad).tape).toBe("FAIL");

    // a tape hour missing; a different head published
    const missing = new Map(tape);
    missing.delete(h0!);
    expect(steps(run.result.log, missing).tape).toBe("FAIL");
    expect(steps(run.result.log, tape, heads, `0x${"ab".repeat(32)}`).replay).toBe("FAIL");
  });

  test("an order signed with the wrong key, for another game, or not canonical never enters the log", () => {
    const g = new PracticeGame({ chainId: CHAIN, id: "e2e-2", rules: practiceRules("test"), seats: [new PracticeBot("e2e-2", 0, practiceTable("e2e-2")).seat], startAt: start, durationMs: 60_000, allowShort: true });
    const mine = new PracticeBot("e2e-2", 0, practiceTable("e2e-2"));
    const stranger = new PracticeBot("someone-else", 0, practiceTable("e2e-2"));
    const order = { seat: mine.seat.address.toLowerCase(), nonce: 1n, kind: "MARKET", symbol: "BTC", product: "PERP", side: "BUY", qty: PX(0.1), leverage: 2n, clientId: "x1" } as const;
    const forged = { bytes: mine.sign(order).bytes, sig: stranger.sign(order).sig };
    expect(g.place(forged.bytes, forged.sig)).toEqual({ ok: false, error: "SIGNATURE" });
    const other = new PracticeBot("e2e-2", 0, practiceTable("another-game")).sign(order);
    expect(g.place(other.bytes, other.sig)).toEqual({ ok: false, error: "OTHER_TABLE" });
    expect(g.host.rec.log.length).toBe(1); // just GameOpen
  });

  test("Practice limits: 15 minutes to 7 days, Practice rules only", () => {
    const seat = new PracticeBot("x", 0, practiceTable("x")).seat;
    expect(() => new PracticeGame({ chainId: CHAIN, id: "x", rules: practiceRules("t"), seats: [seat], startAt: start, durationMs: 60_000 })).toThrow("15 minutes");
    expect(() => new PracticeGame({ chainId: CHAIN, id: "x", rules: { ...practiceRules("t"), mode: "FRIEND" }, seats: [seat], startAt: start, durationMs: 900_000 })).toThrow("not Practice");
    expect(new PracticeGame({ chainId: CHAIN, id: "x", rules: practiceRules("t"), seats: [seat], startAt: start, durationMs: 900_000 }).open.endAt - start).toBe(900_000);
    expect(HOUR_MS).toBe(3_600_000);
  });
});
