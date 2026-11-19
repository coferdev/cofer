/**
 * The shared price tape (spec §4.2, §4.7): one hash-chained tape per UTC hour, shared by every game.
 *
 *   event     = abi.encode(uint8 kind, uint64 seq, bytes payload)      kind 2 = SourceQuote, 3 = Tick
 *   e_i       = keccak256(event_i)
 *   h_0       = keccak256(abi.encode("COFER_ARENA_TAPE_V1", chainId, hourId))
 *   h_i       = keccak256(abi.encodePacked(h_{i-1}, e_i))
 *   tapeHead  = h_N            (signed k-of-n and anchored by ResultRegistry.anchorTape)
 *
 * A SourceQuote is logged when a source's value changes, plus a heartbeat once a second per live source when it
 * does not, so "received after" is replayable. Each Tick carries the marks it produced, and verifyTape recomputes
 * every Tick from the quotes before it, so a tape that does not follow the mark rule fails replay.
 */
import { decodeAbiParameters, encodeAbiParameters, encodePacked, keccak256, type Hex } from "viem";
import { SYMBOLS, isSymbol, type Symbol } from "./markets";
import {
  DEFAULT_MARK_PARAMS, SOURCE_BY_CODE, SOURCE_CODE, STATUS_CODE, computeMark,
  type Mark, type MarkParams, type MarkStatus, type Quote, type Source,
} from "./median";

export const KIND_QUOTE = 2;
export const KIND_TICK = 3;
export const HOUR_MS = 3_600_000;

const QUOTE_PARAMS = [
  { type: "uint8", name: "source" }, { type: "string", name: "symbol" }, { type: "uint256", name: "px" },
  { type: "uint64", name: "recvMs" }, { type: "uint64", name: "srcTs" }, { type: "uint8", name: "flags" },
  { type: "uint8", name: "mode" }, { type: "uint80", name: "roundId" }, { type: "int256", name: "answer" },
  { type: "uint8", name: "decimals" }, { type: "uint256", name: "multiplier" },
] as const;

const TICK_PARAMS = [
  { type: "uint64", name: "tsMs" }, { type: "string[]", name: "symbols" }, { type: "uint256[]", name: "marks" },
  { type: "uint8[]", name: "status" }, { type: "uint256[]", name: "prevValid" }, { type: "uint64[]", name: "venueFreshFromMs" },
  { type: "uint8[]", name: "sourcesMask" },
] as const;

const EVENT_PARAMS = [{ type: "uint8" }, { type: "uint64" }, { type: "bytes" }] as const;

export interface TickRecord {
  tsMs: number;
  marks: Mark[];
  /** Last valid mark per symbol going into this tick (jump guard input); 0n when none. */
  prevValid: bigint[];
}

/** Why a quote is on the tape: its value changed, a once-a-second heartbeat, or carried into a new hour. */
export const MODE_CHANGE = 0;
export const MODE_HEARTBEAT = 1;
export const MODE_CARRY = 2;

export type TapeEvent =
  | { kind: typeof KIND_QUOTE; seq: number; quote: Quote; mode: number }
  | { kind: typeof KIND_TICK; seq: number; tick: TickRecord };

export interface EncodedEvent {
  hourId: number;
  seq: number;
  kind: number;
  encoded: Hex;
  eventHash: Hex;
  chainHash: Hex;
}

export const hourOf = (ms: number) => Math.floor(ms / HOUR_MS);

export function genesis(chainId: number, hourId: number): Hex {
  return keccak256(encodeAbiParameters([{ type: "string" }, { type: "uint256" }, { type: "uint64" }], ["COFER_ARENA_TAPE_V1", BigInt(chainId), BigInt(hourId)]));
}

const STATUS_BY_CODE = Object.fromEntries(Object.entries(STATUS_CODE).map(([k, v]) => [v, k])) as Record<number, MarkStatus>;
const mask = (used: Source[]) => used.reduce((m, s) => m | (1 << (SOURCE_CODE[s] - 1)), 0);
const unmask = (m: number) => (["lighter", "arcus", "chainlink"] as Source[]).filter((s) => m & (1 << (SOURCE_CODE[s] - 1)));

export function encodeEvent(ev: TapeEvent): Hex {
  let payload: Hex;
  if (ev.kind === KIND_QUOTE) {
    const q = ev.quote;
    payload = encodeAbiParameters(QUOTE_PARAMS, [
      SOURCE_CODE[q.source], q.symbol, q.px, BigInt(q.recvMs), BigInt(q.srcTs), q.flags, ev.mode,
      q.round?.roundId ?? 0n, q.round?.answer ?? 0n, q.round?.decimals ?? 0, q.round?.multiplier ?? 0n,
    ]);
  } else {
    const t = ev.tick;
    payload = encodeAbiParameters(TICK_PARAMS, [
      BigInt(t.tsMs), t.marks.map((m) => m.symbol), t.marks.map((m) => m.mark ?? 0n),
      t.marks.map((m) => STATUS_CODE[m.status]), t.prevValid, t.marks.map((m) => BigInt(m.venueFreshFromMs ?? 0)),
      t.marks.map((m) => mask(m.used)),
    ]);
  }
  return encodeAbiParameters(EVENT_PARAMS, [ev.kind, BigInt(ev.seq), payload]);
}

export function decodeEvent(encoded: Hex): TapeEvent {
  const [kind, seq, payload] = decodeAbiParameters(EVENT_PARAMS, encoded);
  if (kind === KIND_QUOTE) {
    const [src, symbol, px, recvMs, srcTs, flags, mode, roundId, answer, decimals, multiplier] = decodeAbiParameters(QUOTE_PARAMS, payload);
    const source = SOURCE_BY_CODE[src];
    if (!source || !isSymbol(symbol)) throw new Error("tape: bad quote");
    const quote: Quote = { source, symbol, px, recvMs: Number(recvMs), srcTs: Number(srcTs), flags };
    if (source === "chainlink") quote.round = { roundId, answer, decimals, multiplier };
    if (mode > MODE_CARRY) throw new Error("tape: bad quote mode");
    return { kind: KIND_QUOTE, seq: Number(seq), quote, mode };
  }
  if (kind === KIND_TICK) {
    const [tsMs, symbols, marks, status, prevValid, fresh, used] = decodeAbiParameters(TICK_PARAMS, payload);
    const ms: Mark[] = symbols.map((s, i) => {
      if (!isSymbol(s)) throw new Error("tape: bad tick symbol");
      const st = STATUS_BY_CODE[status[i]!];
      if (!st) throw new Error("tape: bad status");
      return { symbol: s, status: st, mark: st === "OK" ? marks[i]! : null, used: unmask(used[i]!), venueFreshFromMs: fresh[i] ? Number(fresh[i]) : null };
    });
    return { kind: KIND_TICK, seq: Number(seq), tick: { tsMs: Number(tsMs), marks: ms, prevValid: [...prevValid] } };
  }
  throw new Error(`tape: unknown kind ${kind}`);
}

export const chainStep = (prev: Hex, eventHash: Hex) => keccak256(encodePacked(["bytes32", "bytes32"], [prev, eventHash]));

/**
 * The last few logged quotes per source and symbol. A tick uses, per source, the newest quote received at or before
 * the tick time, so a quote that lands a few ms after the second does not hide the one before it.
 */
export class QuoteBook {
  private q = new Map<string, Quote[]>();
  add(x: Quote) {
    const k = `${x.source}|${x.symbol}`;
    const list = this.q.get(k) ?? [];
    list.push(x);
    if (list.length > 4) list.shift();
    this.q.set(k, list);
  }
  at(tsMs: number): Quote[] {
    const out: Quote[] = [];
    for (const list of this.q.values()) {
      for (let i = list.length - 1; i >= 0; i--) if (list[i]!.recvMs <= tsMs) { out.push(list[i]!); break; }
    }
    return out;
  }
  newest(): Quote[] {
    return [...this.q.values()].map((l) => l[l.length - 1]!);
  }
}

/** A quote's value for the change-or-heartbeat rule. */
const valueKey = (q: Quote) => `${q.px}|${q.flags}|${q.srcTs}|${q.round?.roundId ?? ""}`;

/**
 * Builds the tape: takes live quotes, decides which get logged, makes one Tick per UTC second, and hash-chains it
 * all per hour. `sink` gets every encoded event in order (DB insert, file, stream).
 */
export class TapeWriter {
  private hourId = -1;
  private seq = 0;
  private head: Hex = "0x";
  private book = new QuoteBook();
  private early: Quote[] = [];
  private lastLoggedMs = new Map<string, number>();
  private lastValue = new Map<string, string>();
  private pending = new Map<string, Quote>(); // newest received but not yet logged (unchanged within the second)
  private prevValid = new Map<Symbol, bigint>();

  constructor(
    readonly chainId: number,
    private sink: (e: EncodedEvent) => void,
    private onHourClosed: (hourId: number, tapeHead: Hex, events: number) => void = () => {},
    readonly params: MarkParams = DEFAULT_MARK_PARAMS,
    readonly symbols: Symbol[] = SYMBOLS,
  ) {}

  private roll(ms: number) {
    const h = hourOf(ms);
    if (h <= this.hourId) return;
    if (this.hourId >= 0) this.onHourClosed(this.hourId, this.head, this.seq);
    this.hourId = h;
    this.seq = 0;
    this.head = genesis(this.chainId, h);
    // each hour replays on its own: it starts with the newest quote per source and symbol from before it
    for (const q of this.book.newest()) this.append({ kind: KIND_QUOTE, seq: 0, quote: q, mode: MODE_CARRY });
  }

  private emit(ev: TapeEvent, ms: number) {
    this.roll(ms);
    this.append(ev);
  }

  private append(ev: TapeEvent) {
    ev.seq = this.seq;
    const encoded = encodeEvent(ev);
    const eventHash = keccak256(encoded);
    this.head = chainStep(this.head, eventHash);
    this.sink({ hourId: this.hourId, seq: this.seq, kind: ev.kind, encoded, eventHash, chainHash: this.head });
    this.seq += 1;
  }

  private log(q: Quote, mode: number) {
    const k = `${q.source}|${q.symbol}`;
    this.emit({ kind: KIND_QUOTE, seq: 0, quote: q, mode }, q.recvMs);
    this.book.add(q);
    this.lastLoggedMs.set(k, q.recvMs);
    this.lastValue.set(k, valueKey(q));
    this.pending.delete(k);
  }

  /** A quote arrived. Logged now if its value changed; otherwise kept for the next heartbeat. */
  quote(q: Quote) {
    const k = `${q.source}|${q.symbol}`;
    if (this.hourId >= 0 && hourOf(q.recvMs) < this.hourId) return; // late for a closed hour
    if (this.hourId >= 0 && hourOf(q.recvMs) > this.hourId) {
      this.early.push(q); // the tick timer has not closed the hour yet; logged right after it does
      return;
    }
    if (this.lastValue.get(k) !== valueKey(q)) this.log(q, MODE_CHANGE);
    else this.pending.set(k, q);
  }

  /** Close one UTC second: heartbeats for unchanged live sources, then the Tick. Returns the marks. */
  tick(tsMs: number): Mark[] {
    for (const [k, q] of [...this.pending]) {
      if (q.recvMs <= tsMs && hourOf(q.recvMs) >= this.hourId && tsMs - (this.lastLoggedMs.get(k) ?? 0) >= 1_000) this.log(q, MODE_HEARTBEAT);
    }
    this.roll(tsMs);
    if (this.early.length) {
      const e = this.early.filter((q) => hourOf(q.recvMs) === this.hourId);
      this.early = this.early.filter((q) => hourOf(q.recvMs) > this.hourId);
      for (const q of e) this.quote(q);
    }
    const latest = this.book.at(tsMs);
    const prev = this.symbols.map((s) => this.prevValid.get(s) ?? 0n);
    const marks = this.symbols.map((s, i) => computeMark(s, latest, tsMs, prev[i]! > 0n ? prev[i]! : null, this.params));
    this.emit({ kind: KIND_TICK, seq: 0, tick: { tsMs, marks, prevValid: prev } }, tsMs);
    for (const m of marks) if (m.mark !== null) this.prevValid.set(m.symbol, m.mark);
    return marks;
  }

  /** Close the current hour now (shutdown); returns its head. */
  flush(): { hourId: number; tapeHead: Hex; events: number } | null {
    if (this.hourId < 0) return null;
    return { hourId: this.hourId, tapeHead: this.head, events: this.seq };
  }
}

export interface TapeCheck {
  ok: boolean;
  tapeHead: Hex;
  ticks: number;
  quotes: number;
  problems: string[];
}

/**
 * Replay one hour of tape: check the hash chain, sequence numbers, that every event belongs to the hour, and that
 * every Tick's marks are exactly what the mark rule gives from the quotes logged before it.
 */
export function verifyTape(chainId: number, hourId: number, encoded: Hex[], params: MarkParams = DEFAULT_MARK_PARAMS, expectHead?: Hex): TapeCheck {
  const problems: string[] = [];
  let head = genesis(chainId, hourId);
  const book = new QuoteBook();
  let carrying = true;
  const prevValid = new Map<Symbol, bigint>();
  let ticks = 0;
  let quotes = 0;
  let lastTick = -1;
  encoded.forEach((raw, i) => {
    head = chainStep(head, keccak256(raw));
    let ev: TapeEvent;
    try {
      ev = decodeEvent(raw);
    } catch (e) {
      problems.push(`#${i}: ${(e as Error).message}`);
      return;
    }
    if (ev.seq !== i) problems.push(`#${i}: seq ${ev.seq}`);
    if (ev.kind === KIND_QUOTE) {
      quotes++;
      if (ev.mode === MODE_CARRY) {
        if (!carrying || hourOf(ev.quote.recvMs) >= hourId) problems.push(`#${i}: carried quote out of place`);
      } else {
        carrying = false;
        if (hourOf(ev.quote.recvMs) !== hourId) problems.push(`#${i}: quote outside the hour`);
      }
      book.add(ev.quote);
      return;
    }
    carrying = false;
    ticks++;
    const t = ev.tick;
    if (hourOf(t.tsMs) !== hourId || t.tsMs % 1_000 !== 0 || t.tsMs <= lastTick) problems.push(`#${i}: tick time ${t.tsMs}`);
    lastTick = t.tsMs;
    const q = book.at(t.tsMs);
    t.marks.forEach((m, j) => {
      const known = prevValid.get(m.symbol);
      const prev = t.prevValid[j] ?? 0n;
      if (known !== undefined && known !== prev) problems.push(`#${i} ${m.symbol}: prevValid ${prev} != ${known}`);
      const want = computeMark(m.symbol, q, t.tsMs, prev > 0n ? prev : null, params);
      if (want.status !== m.status || want.mark !== m.mark || want.venueFreshFromMs !== m.venueFreshFromMs || mask(want.used) !== mask(m.used)) {
        problems.push(`#${i} ${m.symbol}: tick says ${m.status} ${m.mark}, rule gives ${want.status} ${want.mark}`);
      }
      if (m.mark !== null) prevValid.set(m.symbol, m.mark);
    });
  });
  if (expectHead && expectHead.toLowerCase() !== head.toLowerCase()) problems.push(`tapeHead ${head} != anchored ${expectHead}`);
  return { ok: problems.length === 0, tapeHead: head, ticks, quotes, problems };
}
