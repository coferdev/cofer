/**
 * Instant Practice games for the App (spec §6.5 Arena · Lobby, Practice tab; roadmap Day 2: "instant 15-min games").
 * Transport-free: the server hands it ticks from the live tape and the players' signed orders, and it says what to
 * send to which room (spec §10.2). No chain, no money, no database.
 *
 *   start(player)   a new game for this player: their seat (a per-game P-256 session key made in the App) plus practice
 *                   bots, starting at the next whole second + 3 s, for 15 minutes
 *   place(...)      a signed order from the player's App, checked exactly as at a real table
 *   tick(ts, marks) one tape tick for every live game; the bots trade; the rooms get marks, the board and `me`
 *   housekeep(now)  closes a game whose tape stopped, and forgets finished games after a while
 *
 * Each player seat gets a fresh random stand-in address per game, so a public Practice log never names an account
 * or a Telegram user. A finished game's log and summary are written like `practice/run.ts` writes them, so
 * `arena-replay verify-practice` checks it from the log and the tape alone.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Hex, bytesToHex, getAddress } from "viem";
import type { SeatEvent } from "../engine/host";
import { isSessionKey } from "../engine/session";
import { MARKETS, type Symbol } from "../marks/markets";
import type { Mark } from "../marks/median";
import { PracticeBot } from "../practice/bots";
import { PracticeGame, practiceRules, practiceTable } from "../practice/practice";
import { summaryJson } from "../practice/run";
import { markView, seatView } from "./seatView";

export type Send = (room: string, ev: string, data: unknown) => void;

export const PRACTICE_MINUTES = [15, 30, 60] as const;
export const MAX_BOTS = 9;
export const BOARD_TOP = 10;
const KEEP_FINISHED_MS = 30 * 60_000;
const TAPE_STALL_MS = 120_000;

interface Live {
  id: string;
  tg: number;
  game: PracticeGame;
  bots: PracticeBot[];
  seat: string; // the player's stand-in address, lowercase
  names: Map<string, string>;
  createdAt: number;
  finishedAt: number | null;
  summary: ReturnType<typeof summaryJson> | null;
  files: { log: string; json: string } | null;
}

export interface HubOpts {
  chainId: number;
  outDir: string;
  tapeDir: string;
  send: Send;
  now?: () => number;
  maxGames?: number;
  engine?: string;
  /** Tests only: shorter games. */
  allowShort?: boolean;
}

export type StartResult =
  | { ok: true; id: string; table: Hex; seat: Hex; startAt: number; endAt: number }
  | { ok: false; error: "KEY" | "BUSY" | "FULL" | "LENGTH" | "BOTS" };

export class PracticeHub {
  private readonly games = new Map<string, Live>();
  private readonly now: () => number;
  private readonly halted = new Map<string, { status: string; since: number }>();
  lastTickAt = 0;

  constructor(private readonly o: HubOpts) {
    this.now = o.now ?? Date.now;
    mkdirSync(o.outDir, { recursive: true });
  }

  /** The player's live (not yet finished) game, if any. */
  liveOf(tg: number): Live | undefined {
    for (const g of this.games.values()) if (g.tg === tg && !g.game.finished) return g;
    return undefined;
  }

  start(p: { tg: number; pubkey: Hex; bots?: number; minutes?: number; durationMs?: number }): StartResult {
    if (!isSessionKey(p.pubkey)) return { ok: false, error: "KEY" };
    const bots = p.bots ?? 3;
    if (!Number.isInteger(bots) || bots < 1 || bots > MAX_BOTS) return { ok: false, error: "BOTS" };
    const minutes = p.minutes ?? 15;
    if (!(PRACTICE_MINUTES as readonly number[]).includes(minutes) && p.durationMs === undefined) return { ok: false, error: "LENGTH" };
    if (p.durationMs !== undefined && !this.o.allowShort) return { ok: false, error: "LENGTH" };
    if (this.liveOf(p.tg)) return { ok: false, error: "BUSY" };
    if ([...this.games.values()].filter((g) => !g.game.finished).length >= (this.o.maxGames ?? 40)) return { ok: false, error: "FULL" };

    const now = this.now();
    const id = `app-${new Date(now).toISOString().replace(/[-:]/g, "").slice(0, 15)}-${bytesToHex(crypto.getRandomValues(new Uint8Array(4))).slice(2)}`;
    const table = practiceTable(id);
    const seat = getAddress(bytesToHex(crypto.getRandomValues(new Uint8Array(20))));
    const botSeats = Array.from({ length: bots }, (_, i) => new PracticeBot(id, i, table));
    const startAt = Math.ceil(now / 1000) * 1000 + 3000;
    const game = new PracticeGame({
      chainId: this.o.chainId, id, rules: practiceRules(this.o.engine ?? "cofer-arena-engine"),
      seats: [{ address: seat, pubkey: p.pubkey }, ...botSeats.map((b) => b.seat)],
      startAt, durationMs: p.durationMs ?? minutes * 60_000, now: this.now, allowShort: this.o.allowShort,
    });
    const names = new Map<string, string>([[seat.toLowerCase(), "You"], ...botSeats.map((b, i) => [b.seat.address.toLowerCase(), `Bot ${i + 1}`] as [string, string])]);
    this.games.set(id, { id, tg: p.tg, game, bots: botSeats, seat: seat.toLowerCase(), names, createdAt: now, finishedAt: null, summary: null, files: null });
    return { ok: true, id, table, seat, startAt, endAt: game.open.endAt };
  }

  /** A signed order from the App. Only the game's own player may send to it (the bots trade inside the hub). */
  place(tg: number, id: string, bytes: Hex, sig: Hex) {
    const g = this.games.get(id);
    if (!g || g.tg !== tg) return { ok: false as const, error: "NOT_FOUND" as const };
    const r = g.game.place(bytes, sig);
    if (r.ok) this.fanOut(g, r.out);
    return r;
  }

  tick(ts: number, marks: Map<string, Mark>): void {
    this.lastTickAt = this.now();
    for (const m of marks.values()) {
      this.o.send(`sym:${m.symbol}`, "mark", markView(m, ts));
      const was = this.halted.get(m.symbol);
      if (m.status !== "OK" && m.status !== "CLOSED") {
        if (!was) this.halted.set(m.symbol, { status: m.status, since: ts });
        this.o.send(`sym:${m.symbol}`, "halt", { s: m.symbol, ...this.halted.get(m.symbol)! });
      } else if (was) {
        this.halted.delete(m.symbol);
        this.o.send(`sym:${m.symbol}`, "halt", { s: m.symbol, status: m.status, since: null });
      }
    }
    for (const g of this.games.values()) {
      if (g.game.finished) continue;
      const out = g.game.tick(ts, marks);
      if (g.game.finished) {
        this.finish(g);
        continue;
      }
      if (ts < g.game.open.lockedAt) continue;
      for (const b of g.bots) for (const x of b.afterTick()) g.game.place(x.bytes, x.sig);
      this.fanOut(g, out);
      this.o.send(`t:${g.game.open.table}`, "board", this.board(g, ts));
      this.o.send(`t:${g.game.open.table}:${g.seat}`, "me", this.me(g));
    }
  }

  housekeep(now = this.now()): void {
    for (const g of [...this.games.values()]) {
      if (!g.game.finished && now > g.game.open.endAt + TAPE_STALL_MS) this.finish(g); // the tape stopped near the end
      if (g.finishedAt !== null && now - g.finishedAt > KEEP_FINISHED_MS) this.games.delete(g.id);
    }
  }

  /** Is the tape moving? The lobby refuses to start a game on a stopped tape. */
  tapeLive(now = this.now()): boolean {
    return now - this.lastTickAt < 10_000;
  }

  private fanOut(g: Live, out: SeatEvent[]) {
    for (const e of out) {
      if (e.seat !== g.seat) continue; // a bot's fills go nowhere
      const room = `t:${g.game.open.table}:${g.seat}`;
      if (e.ev === "fill") this.o.send(room, "fill", e);
      else if (e.ev === "reject") this.o.send(room, "reject", { ref: e.ref, reason: e.reason });
      else this.o.send(room, "eliminated", { tickTs: e.tickTs });
    }
  }

  board(g: Live, ts: number) {
    const all = g.game.host.board(g.game.open.seats.length);
    const row = (s: (typeof all)[number]) => ({ seat: s.seat, name: g.names.get(s.seat) ?? s.seat.slice(0, 8), rank: s.rank, scoreE6: s.score1e6, equity: s.finalEquity, out: s.eliminatedAt !== null });
    const top = all.slice(0, BOARD_TOP).map(row);
    const mine = all.find((s) => s.seat === g.seat);
    return { top, me: mine && mine.rank > BOARD_TOP ? row(mine) : null, n: all.length, ts, endAt: g.game.open.endAt };
  }

  me(g: Live) {
    return { ...seatView(g.game.host.rec.game, g.seat, this.now()), seat: g.seat };
  }

  private finish(g: Live) {
    const r = g.game.close();
    g.summary = summaryJson(g.game, g.id, g.bots.length);
    g.finishedAt = this.now();
    const log = join(this.o.outDir, `practice-${g.id}.log`);
    const json = join(this.o.outDir, `practice-${g.id}.json`);
    try {
      writeFileSync(log, `${r.log.join("\n")}\n`);
      writeFileSync(json, `${JSON.stringify(g.summary, null, 2)}\n`);
      g.files = { log, json };
    } catch {
      g.files = null; // the result still shows; only the download is missing
    }
    this.o.send(`t:${g.game.open.table}`, "result", this.result(g));
  }

  result(g: Live) {
    const s = g.summary!;
    return {
      id: g.id, table: g.game.open.table, head: s.head, ticks: s.ticks, events: s.events,
      standings: s.standings.map((x) => ({ ...x, name: g.names.get(x.seat.toLowerCase()) ?? x.seat.slice(0, 8) })),
      verify: `bun tools/arena-replay/arena-replay.ts verify-practice --log practice-${g.id}.log --tape <tape folder> --head ${s.head}`,
    };
  }

  /** A game as the App's Live screen loads it (rules, seats, times; then the current board, `me` and the result). */
  get(tg: number, id: string) {
    const g = this.games.get(id);
    if (!g || g.tg !== tg) return null;
    const o = g.game.open;
    const ts = g.game.host.rec.game.lastTs ?? o.lockedAt;
    return {
      id, table: o.table, seat: g.seat, startAt: o.lockedAt, endAt: o.endAt, rulesHash: o.rulesHash, rules: JSON.parse(o.rulesJson),
      leverageCap: Object.fromEntries(Object.entries(MARKETS).map(([sym, m]) => [sym, Number(g.game.host.rec.game.book.rules.leverageCap[m.cls] ?? 1n)])) as Record<Symbol, number>,
      seats: o.seats.map((s) => ({ seat: s.toLowerCase(), name: g.names.get(s.toLowerCase())! })),
      board: this.board(g, ts), me: this.me(g), result: g.summary ? this.result(g) : null,
    };
  }

  /** The Practice tab: this player's games, newest first. */
  list(tg: number) {
    return [...this.games.values()]
      .filter((g) => g.tg === tg)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((g) => ({ id: g.id, table: g.game.open.table, startAt: g.game.open.lockedAt, endAt: g.game.open.endAt, seats: g.game.open.seats.length, finished: g.game.finished, rank: g.summary?.standings.find((s) => s.seat.toLowerCase() === g.seat)?.rank ?? null }));
  }

  /** The finished log, for the "download the log" link (the public replay needs it). */
  files(tg: number, id: string) {
    const g = this.games.get(id);
    return g && g.tg === tg ? g.files : null;
  }
}
