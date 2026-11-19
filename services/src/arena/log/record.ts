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
import { type Game, type GameEmitted, newGame, step } from "../engine/game";
import type { Order, Rules } from "../engine/orders";
import { HOUR_MS } from "../marks/tape";
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

  constructor(readonly open: Open, rules: Rules) {
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

  private outputs(out: GameEmitted[]) {
    for (const e of out) {
      const x = outputEvent(e);
      if (x) this.put(x);
    }
  }

  order(o: Order, signature: Hex, recvTs: number): GameEmitted[] {
    this.flush();
    const seq = this.put({ type: "OrderIn", payload: [o.seat as Hex, encodeOrder(this.open.table, o), signature, BigInt(recvTs)] });
    const out = step(this.game, { t: "OrderIn", seq, recvTs, order: o });
    this.outputs(out);
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
    return out;
  }

  /** Close the log (the GameClose event with standings is added by the result builder). */
  end(): Hex {
    this.flush();
    return this.chain.head;
  }
}

export interface ReplayResult {
  ok: boolean;
  head: Hex;
  problems: string[];
}

/**
 * Replay a log: read its inputs, run them through a fresh Recorder with ticks from the tape, compare every event.
 * The chain id is in h_0 (not in GameOpen), so the head only matches on the chain the game ran on.
 * `ticks(ts)` gives the tape's marks at a tick (from verified tape hours), or undefined if the tape has no such tick.
 */
export function replayLog(chainId: number, log: Hex[], rules: Rules, ticks: Ticks, expectedHead?: Hex): ReplayResult {
  const problems: string[] = [];
  const first = decodeLogEvent(log[0]!);
  if (first.type !== "GameOpen") return { ok: false, head: "0x", problems: ["the log does not start with GameOpen"] };
  const p = first.payload as [Hex, Hex, string, Hex[], Hex[], bigint, bigint, bigint, bigint[]];
  const open: Open = { chainId, table: p[0], rulesHash: p[1], rulesJson: p[2], seats: [...p[3]], pubkeys: [...p[4]], lockedAt: Number(p[5]), endAt: Number(p[6]), lockBlock: p[7], tapeHours: p[8].map(Number) };
  const r = new Recorder(open, rules);
  for (let i = 1; i < log.length; i++) {
    const e = decodeLogEvent(log[i]!);
    if (e.type === "OrderIn") {
      const [, bytes, sig, recv] = e.payload as [Hex, Hex, Hex, bigint];
      const { table, order } = decodeOrder(bytes);
      if (table !== open.table.toLowerCase()) problems.push(`#${i}: order for another table`);
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
  const head = r.end();
  const n = Math.max(log.length, r.log.length);
  for (let i = 0; i < n && problems.length < 20; i++) {
    if (log[i] !== r.log[i]) problems.push(`#${i}: the log says ${log[i] ? decodeLogEvent(log[i]!).type : "nothing"}, the replay gives ${r.log[i] ? decodeLogEvent(r.log[i]!).type : "nothing"}`);
  }
  if (expectedHead && head !== expectedHead) problems.push(`head ${head} is not the posted ${expectedHead}`);
  return { ok: problems.length === 0, head, problems };
}
