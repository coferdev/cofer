/**
 * One live game on an engine shard (spec §5.2, §10.2): the transport-free core behind arena-ws.
 *   place(bytes, sig)  an order as the App sends it: the canonical ABI bytes it signed, and the P-256 signature.
 *                      Checked (decodes, re-encodes to the same bytes, this table, a seat, the signature) before it is
 *                      stamped with the engine's recvTs and logged. Anything refused never enters the log.
 *   tick(ts, marks)    a tape tick; returns the fan-out (fills and rejects per seat).
 *   board(n)           the live top n by score at the last tick (the same scoring as the close).
 * The clock is passed in, so the host is deterministic under test and a replay gives the same log.
 */
import type { Hex } from "viem";
import { decodeOrder, encodeOrder } from "../log/events";
import { type Open, Recorder } from "../log/record";
import type { Mark } from "../marks/median";
import { lbZadd } from "../scoring/leaderboard";
import { type ScoreRules, type Standing, rank } from "../scoring/score";
import type { GameEmitted } from "./game";
import type { Rules } from "./orders";
import { orderSigProblem } from "./session";

export type PlaceResult =
  | { ok: true; ref: string; recvTs: number; out: SeatEvent[] }
  | { ok: false; error: "BAD_ORDER" | "NOT_CANONICAL" | "OTHER_TABLE" | "SIGNATURE" | "CLOSED" };

/** What goes to the seat room `t:<table>:<seat>`. */
export type SeatEvent =
  | { seat: string; ev: "fill"; ref: string; px: bigint; qty: bigint; tickTs: number }
  | { seat: string; ev: "fill"; ref: string; series: string; contracts: bigint; chips: bigint; tickTs: number }
  | { seat: string; ev: "reject"; ref: string; reason: string }
  | { seat: string; ev: "eliminated"; tickTs: number };

export function seatEvents(out: GameEmitted[]): SeatEvent[] {
  const r: SeatEvent[] = [];
  for (const e of out) {
    if (e.t === "Fill") r.push({ seat: e.seat, ev: "fill", ref: e.clientId, px: e.px, qty: e.dq, tickTs: e.ts });
    else if (e.t === "OptFill") r.push({ seat: e.seat, ev: "fill", ref: e.clientId, series: e.series, contracts: e.contracts, chips: e.chips, tickTs: e.ts });
    else if (e.t === "Reject") r.push({ seat: e.seat, ev: "reject", ref: e.clientId, reason: e.reason });
    else if (e.t === "Eliminate") r.push({ seat: e.seat, ev: "eliminated", tickTs: e.ts });
  }
  return r;
}

export class GameHost {
  readonly rec: Recorder;
  private closed = false;

  constructor(readonly open: Open, rules: Rules, private readonly score: Omit<ScoreRules, "durationMs">, private readonly now: () => number) {
    this.rec = new Recorder(open, rules);
  }

  place(bytes: Hex, sig: Hex): PlaceResult {
    if (this.closed) return { ok: false, error: "CLOSED" };
    let dec: ReturnType<typeof decodeOrder>;
    try {
      dec = decodeOrder(bytes);
    } catch {
      return { ok: false, error: "BAD_ORDER" };
    }
    if (dec.table !== this.open.table.toLowerCase()) return { ok: false, error: "OTHER_TABLE" };
    if (encodeOrder(this.open.table, dec.order).toLowerCase() !== bytes.toLowerCase()) return { ok: false, error: "NOT_CANONICAL" };
    if (orderSigProblem(this.open.seats, this.open.pubkeys, dec.order.seat as Hex, bytes, sig)) return { ok: false, error: "SIGNATURE" };
    const recvTs = this.now();
    const out = this.rec.order(dec.order, sig, recvTs);
    return { ok: true, ref: dec.order.clientId, recvTs, out: seatEvents(out) };
  }

  tick(ts: number, marks: Map<string, Mark>): SeatEvent[] {
    if (this.closed) return [];
    return seatEvents(this.rec.tick(ts, marks));
  }

  /** The ZADD arguments for `lb:<table>` at the last tick (every seat). */
  lb(): (number | string)[] {
    return lbZadd(this.board(this.open.seats.length), this.rec.game.startAt);
  }

  board(n: number): Standing[] {
    const g = this.rec.game;
    const inputs = g.seats.map((seat, index) => {
      const a = g.samples.get(seat)!;
      return { seat, index, finalEquity: a.lastEquity, maxDdBps: a.maxDdBps, fills: a.fills, exposedMs: a.exposedMs, eliminatedAt: g.book.seats.get(seat)!.ledger.eliminatedAt };
    });
    const elapsed = Math.max(1, (g.lastTs ?? g.startAt) - g.startAt);
    return rank(inputs, { ...this.score, durationMs: elapsed }).slice(0, n);
  }

  close(): { standings: Standing[]; head: Hex } {
    this.closed = true;
    return this.rec.close(this.score);
  }
}
