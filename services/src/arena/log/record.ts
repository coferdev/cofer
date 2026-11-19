/**
 * Recording a game and replaying it (spec §4.7, §4.8). The log holds the inputs (GameOpen, OrderIn, TickRef) and,
 * after each input, the outputs the engine produced from it. Replay takes only the inputs from a log, runs the same
 * fold over the tape's ticks, writes the log again and compares it event by event: any difference in any output,
 * or any changed byte, is found.
 *
 * Ticks are referenced, not copied: consecutive ticks that produce no output share one TickRef (hour, first, last).
 */
import type { Hex } from "viem";
import type { Mark } from "../marks/median";
import { encodeAbiParameters } from "viem";
import { type Game, type GameEmitted, finish, newGame, step } from "../engine/game";
import { type ScoreRules, type Standing, rank } from "../scoring/score";
import { DEFAULT_COLLUSION, detect } from "../scoring/collusion";

/** In a Flag event, ρ when there were too few shared samples to measure it. */
export const RHO_UNSET = -(2n ** 255n);
import type { Order, Rules } from "../engine/orders";
import { HOUR_MS } from "../marks/tape";
import { orderSigProblem } from "../engine/session";
import { LogChain } from "./chain";
import { type LogEvent, decodeLogEvent, decodeOrder, encodeLogEvent, encodeOrder } from "./events";

export interface Open {
  chainId: number;
  table: Hex;
  rulesHash: Hex;
  rulesJson: string;
  seats: Hex[];
  pubkeys: Hex[];
  lockedAt: number; // ms (the game clock starts here)
  endAt: number; // ms
  lockBlock: bigint;
  tapeHours: number[];
}

export type Ticks = (ts: number) => Map<string, Mark> | undefined;

/** One engine output → its log event (payload layout in events.ts). */
function outputEvent(e: GameEmitted): Omit<LogEvent, "seq"> | null {
  switch (e.t) {
    case "Reject": return { type: "OrderReject", payload: [e.clientId, e.reason] };
    case "Fill": return { type: "Fill", payload: [e.clientId, BigInt(e.ts), e.symbol, e.product, e.dq, e.px, e.fee, e.realised] };
    case "Cancelled": return { type: "Cancel", payload: [e.ref, "player", e.clientId] };
    case "Fired": return null; // a trigger firing is derived again by the replay; its fill is logged
    case "OptFill": return { type: "OptionFill", payload: [e.clientId, e.series, e.contracts, e.chips] };
    case "OptionList": return { type: "OptionList", payload: [e.sym, BigInt(e.expiry), e.series, 0n] };
    case "OptionSettle": return { type: "OptionSettle", payload: [e.sym, BigInt(e.expiry), e.px, e.credits.map((c) => c[0] as Hex), e.credits.map((c) => c[1])] };
    case "Eliminate": return { type: "Eliminate", payload: [e.seat as Hex, BigInt(e.ts), e.equityBefore] };
    case "Accepted": return null; // acceptance is implied by the absence of a reject
  }
}

export class Recorder {
  readonly chain: LogChain;
  readonly log: Hex[] = [];
  readonly game: Game;
  private pending: { hour: number; first: number; last: number } | null = null;

  /** `checkSigs` false only in replay, which reports a bad signature as a problem instead of stopping. */
  constructor(readonly open: Open, rules: Rules, private readonly checkSigs = true) {
    this.chain = new LogChain(open.chainId, open.table, open.rulesHash);
    this.game = newGame(rules, open.seats.map((s) => s.toLowerCase()), open.lockedAt, open.endAt);
    this.put({ type: "GameOpen", payload: [open.table, open.rulesHash, open.rulesJson, open.seats, open.pubkeys, BigInt(open.lockedAt), BigInt(open.endAt), open.lockBlock, open.tapeHours.map(BigInt)] });
  }

  private put(e: Omit<LogEvent, "seq">): number {
    const seq = this.log.length;
    const enc = encodeLogEvent({ ...e, seq: BigInt(seq) });
    this.log.push(enc);
    this.chain.append(enc);
    return seq;
  }

  private flush() {
    if (!this.pending) return;
    const p = this.pending;
    this.pending = null;
    this.put({ type: "TickRef", payload: [BigInt(p.hour), BigInt(p.first), BigInt(p.last)] });
  }

  /** Optional observer (the replay tool's `me`): every engine output, and the game after each tick. Never changes the log. */
  watch?: { emitted?: (e: GameEmitted) => void; tick?: (ts: number, g: Game) => void };

  private outputs(out: GameEmitted[]) {
    for (const e of out) {
      const x = outputEvent(e);
      if (x) this.put(x);
    }
  }

  order(o: Order, signature: Hex, recvTs: number): GameEmitted[] {
    const bytes = encodeOrder(this.open.table, o);
    if (this.checkSigs) {
      const bad = orderSigProblem(this.open.seats, this.open.pubkeys, o.seat as Hex, bytes, signature);
      if (bad) throw new Error(`order not logged: ${bad}`); // never enters the log
    }
    this.flush();
    const seq = this.put({ type: "OrderIn", payload: [o.seat as Hex, bytes, signature, BigInt(recvTs)] });
    const out = step(this.game, { t: "OrderIn", seq, recvTs, order: o });
    this.outputs(out);
    if (this.watch?.emitted) out.forEach(this.watch.emitted);
    return out;
  }

  tick(ts: number, marks: Map<string, Mark>): GameEmitted[] {
    const hour = Math.floor(ts / HOUR_MS);
    if (this.pending && this.pending.hour !== hour) this.flush();
    if (this.pending) this.pending.last = ts;
    else this.pending = { hour, first: ts, last: ts };
    const out = step(this.game, { t: "Tick", seq: this.log.length, ts, marks });
    if (out.some((e) => outputEvent(e) !== null)) {
      this.flush();
      this.outputs(out);
    }
    if (this.watch?.emitted) out.forEach(this.watch.emitted);
    this.watch?.tick?.(ts, this.game);
    return out;
  }

  /** Stop at the last tick without closing (a partial log, e.g. for a live check). */
  end(): Hex {
    this.flush();
    return this.chain.head;
  }

  /**
   * Game end: positions close at the last valid marks (engine/game.ts finish), the seats are ranked, and GameClose
   * (endAt, the standings rows) is the last event. Returns the standings and the final head.
   */
  close(score: Omit<ScoreRules, "durationMs">, flaggedPairs: [string, string][] = []): { standings: Standing[]; head: Hex } {
    this.flush();
    const g = this.game;
    finish(g, g.endAt);
    const inputs = g.seats.map((seat, index) => {
      const a = g.samples.get(seat)!;
      const s = g.book.seats.get(seat)!;
      return { seat, index, finalEquity: s.ledger.cash, maxDdBps: a.maxDdBps, fills: a.fills, exposedMs: a.exposedMs, eliminatedAt: s.ledger.eliminatedAt };
    });
    // collusion (spec §4.10): part of the replay, so anyone can check it; each flagged pair is logged with its metrics
    const found = detect(g.seats.map((s) => g.traces.get(s)!), g.book.rules.collusion ?? DEFAULT_COLLUSION);
    for (const m of found.all.filter((x) => x.flagged))
      this.put({ type: "Flag", payload: ["COLLUSION", [m.a as Hex, m.b as Hex], [m.oBps, m.rhoBps ?? RHO_UNSET, BigInt(m.sync), m.eliminatedHolding ? 1n : 0n]] });
    const key = (a: string, b: string) => [a.toLowerCase(), b.toLowerCase()].sort().join();
    const pairs = new Map<string, [string, string]>();
    for (const pr of [...found.flagged, ...flaggedPairs]) pairs.set(key(pr[0], pr[1]), pr);
    const standings = rank(inputs, { ...score, durationMs: g.endAt - g.startAt }, [...pairs.values()]);
    this.put({ type: "GameClose", payload: [BigInt(g.endAt), encodeStandings(standings)] });
    return { standings, head: this.chain.head };
  }
}

export const STANDING_ROW = [{ type: "tuple[]", components: [
  { name: "rank", type: "uint256" }, { name: "seat", type: "address" }, { name: "finalEquity", type: "int256" },
  { name: "maxDrawdownBps", type: "uint256" }, { name: "score1e6", type: "int256" }, { name: "activityOk", type: "bool" },
  { name: "eliminatedAt", type: "uint64" }, { name: "flags", type: "uint256" },
] }] as const;

export const encodeStandings = (rows: Standing[]): Hex => encodeAbiParameters(STANDING_ROW, [rows.map((r) => ({
  rank: BigInt(r.rank), seat: r.seat as Hex, finalEquity: r.finalEquity, maxDrawdownBps: r.maxDrawdownBps, score1e6: r.score1e6,
  activityOk: r.activityOk, eliminatedAt: BigInt(r.eliminatedAt ?? 0), flags: BigInt(r.flags),
}))]);

export interface ReplayResult {
  ok: boolean;
  head: Hex;
  problems: string[];
  /** The rebuilt recorder (its chain gives eventsRoot; its standings come from GameClose when the log is closed). */
  recorder?: Recorder;
  standings?: Standing[];
}

/**
 * Replay a log: read its inputs, run them through a fresh Recorder with ticks from the tape, compare every event.
 * The chain id is in h_0 (not in GameOpen), so the head only matches on the chain the game ran on.
 * `ticks(ts)` gives the tape's marks at a tick (from verified tape hours), or undefined if the tape has no such tick.
 */
export function replayLog(chainId: number, log: Hex[], rules: Rules, ticks: Ticks, expectedHead?: Hex, score?: Omit<ScoreRules, "durationMs">, flaggedPairs: [string, string][] = [], watch?: Recorder["watch"]): ReplayResult {
  const problems: string[] = [];
  const first = decodeLogEvent(log[0]!);
  if (first.type !== "GameOpen") return { ok: false, head: "0x", problems: ["the log does not start with GameOpen"] };
  const p = first.payload as [Hex, Hex, string, Hex[], Hex[], bigint, bigint, bigint, bigint[]];
  const open: Open = { chainId, table: p[0], rulesHash: p[1], rulesJson: p[2], seats: [...p[3]], pubkeys: [...p[4]], lockedAt: Number(p[5]), endAt: Number(p[6]), lockBlock: p[7], tapeHours: p[8].map(Number) };
  const r = new Recorder(open, rules, false);
  r.watch = watch;
  for (let i = 1; i < log.length; i++) {
    const e = decodeLogEvent(log[i]!);
    if (e.type === "OrderIn") {
      const [seat, bytes, sig, recv] = e.payload as [Hex, Hex, Hex, bigint];
      const { table, order } = decodeOrder(bytes);
      if (table !== open.table.toLowerCase()) problems.push(`#${i}: order for another table`);
      if (seat.toLowerCase() !== order.seat) problems.push(`#${i}: logged for ${seat} but the order is ${order.seat}'s`);
      const bad = orderSigProblem(open.seats, open.pubkeys, seat, bytes, sig);
      if (bad) problems.push(`#${i}: ${bad}`);
      r.order(order, sig, Number(recv));
    } else if (e.type === "TickRef") {
      const [, a, b] = (e.payload as bigint[]).map(Number);
      for (let ts = a!; ts <= b!; ts += 1000) {
        const m = ticks(ts);
        if (!m) {
          problems.push(`#${i}: tape has no tick at ${ts}`);
          continue;
        }
        r.tick(ts, m);
      }
    }
  }
  let standings: Standing[] | undefined;
  let head: Hex;
  if (decodeLogEvent(log[log.length - 1]!).type === "GameClose") {
    if (!score) return { ok: false, head: "0x", problems: ["a closed log needs the scoring rules"] };
    ({ standings, head } = r.close(score, flaggedPairs));
  } else head = r.end();
  const n = Math.max(log.length, r.log.length);
  for (let i = 0; i < n && problems.length < 20; i++) {
    if (log[i] !== r.log[i]) problems.push(`#${i}: the log says ${log[i] ? decodeLogEvent(log[i]!).type : "nothing"}, the replay gives ${r.log[i] ? decodeLogEvent(r.log[i]!).type : "nothing"}`);
  }
  if (expectedHead && head !== expectedHead) problems.push(`head ${head} is not the posted ${expectedHead}`);
  return { ok: problems.length === 0, head, problems, recorder: r, standings };
}
