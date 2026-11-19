import { describe, expect, test } from "bun:test";
import { keccak256, type Hex } from "viem";
import { parsePrice } from "../src/arena/marks/markets";
import type { Quote } from "../src/arena/marks/median";
import {
  HOUR_MS, KIND_QUOTE, KIND_TICK, MODE_CARRY, MODE_HEARTBEAT, TapeWriter, decodeEvent, encodeEvent, genesis, hourOf, verifyTape,
  type EncodedEvent,
} from "../src/arena/marks/tape";

const P = (s: string) => parsePrice(s)!;
const H0 = Date.parse("2026-11-19T15:00:00Z"); // stock session open, hour start

/** Deterministic made-up feed: BTC from three sources and NVDA from three, one quote per source per 500 ms. */
function run(seconds: number, startMs = H0, mutate?: (q: Quote) => Quote | null) {
  const events: EncodedEvent[] = [];
  const closed: { hourId: number; head: Hex; n: number }[] = [];
  const w = new TapeWriter(46630, (e) => events.push(e), (hourId, head, n) => closed.push({ hourId, head, n }));
  let x = 63_800;
  for (let s = 0; s < seconds; s++) {
    const t0 = startMs + s * 1000;
    for (const off of [120, 620]) {
      x += ((s * 7 + off) % 5) - 2; // small deterministic wiggle
      const base: Quote[] = [
        { source: "lighter", symbol: "BTC", px: P(String(x)), recvMs: t0 + off, srcTs: 0, flags: 0 },
        { source: "arcus", symbol: "BTC", px: P(String(x + 3)), recvMs: t0 + off + 30, srcTs: 0, flags: 0 },
        { source: "lighter", symbol: "NVDA", px: P("153.10"), recvMs: t0 + off, srcTs: 0, flags: 0 }, // unchanged -> heartbeats
        { source: "arcus", symbol: "NVDA", px: P("153.12"), recvMs: t0 + off + 10, srcTs: 0, flags: 0 },
      ];
      if (off === 120) base.push({
        source: "chainlink", symbol: "BTC", px: P("63790"), recvMs: t0 + off + 50, srcTs: Math.floor(startMs / 1000) - 30, flags: 0,
        round: { roundId: 18446744073709551999n, answer: 6_379_000_000_000n, decimals: 8, multiplier: 10n ** 18n },
      });
      for (const q of base) {
        const m = mutate ? mutate(q) : q;
        if (m) w.quote(m);
      }
    }
    w.tick(t0 + 1000);
  }
  return { events, closed, w };
}

describe("tape encoding", () => {
  test("quote and tick events round-trip", () => {
    const { events } = run(3);
    for (const e of events) {
      const d = decodeEvent(e.encoded);
      expect(encodeEvent(d)).toBe(e.encoded);
      expect(keccak256(e.encoded)).toBe(e.eventHash);
    }
    expect(events.some((e) => e.kind === KIND_TICK)).toBe(true);
  });
  test("genesis names the chain and the hour", () => {
    expect(genesis(4663, 1)).not.toBe(genesis(46630, 1));
    expect(genesis(4663, 1)).not.toBe(genesis(4663, 2));
  });
});

describe("tape writer and replay check", () => {
  test("a clean hour verifies and its head matches the writer", () => {
    const { events, w } = run(120);
    const hour = hourOf(H0);
    const v = verifyTape(46630, hour, events.map((e) => e.encoded));
    expect(v.problems).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.tapeHead).toBe(w.flush()!.tapeHead);
    expect(v.ticks).toBe(120);
    const ticks = events.filter((e) => e.kind === KIND_TICK).map((e) => decodeEvent(e.encoded));
    const last = ticks[ticks.length - 1]!;
    if (last.kind !== KIND_TICK) throw new Error();
    expect(last.tick.marks.find((m) => m.symbol === "BTC")!.status).toBe("OK");
    expect(last.tick.marks.find((m) => m.symbol === "NVDA")!.mark).toBe(P("153.11"));
    expect(last.tick.marks.find((m) => m.symbol === "SPY")!.status).toBe("NO_QUORUM");
  });
  test("unchanged quotes are logged once a second as heartbeats, not on every read", () => {
    const { events } = run(10);
    const nv = events.map((e) => decodeEvent(e.encoded)).filter((e) => e.kind === KIND_QUOTE && e.quote.symbol === "NVDA" && e.quote.source === "lighter");
    expect(nv.length).toBeGreaterThanOrEqual(9);
    expect(nv.length).toBeLessThanOrEqual(11);
    expect(nv.slice(1).every((e) => e.kind === KIND_QUOTE && e.mode === MODE_HEARTBEAT)).toBe(true);
  });
  test("same input, same tape, bit for bit", () => {
    const a = run(30).events.map((e) => e.chainHash);
    const b = run(30).events.map((e) => e.chainHash);
    expect(a).toEqual(b);
  });
  test("a changed price, a dropped event, a swapped order or a wrong anchor all fail", () => {
    const { events } = run(30);
    const raw = events.map((e) => e.encoded);
    const hour = hourOf(H0);
    // forge a tick with a different BTC mark
    const i = events.findIndex((e) => e.kind === KIND_TICK);
    const d = decodeEvent(raw[i]!);
    if (d.kind !== KIND_TICK) throw new Error();
    const btc = d.tick.marks.find((m) => m.symbol === "BTC")!;
    btc.mark = btc.mark! + 10_000_000n;
    const forged = [...raw];
    forged[i] = encodeEvent(d);
    expect(verifyTape(46630, hour, forged).ok).toBe(false);
    expect(verifyTape(46630, hour, raw.filter((_, j) => j !== 3)).ok).toBe(false);
    const swapped = [...raw];
    [swapped[1], swapped[2]] = [swapped[2]!, swapped[1]!];
    expect(verifyTape(46630, hour, swapped).ok).toBe(false);
    expect(verifyTape(46630, hour, raw, undefined, genesis(46630, hour)).ok).toBe(false);
    expect(verifyTape(4663, hour, raw, undefined, events[events.length - 1]!.chainHash).ok).toBe(false);
  });
  test("each hour closes with its head and the next hour replays on its own", () => {
    const start = H0 + HOUR_MS - 30_000;
    const { events, closed } = run(60, start);
    expect(closed.length).toBe(1);
    const h1 = hourOf(start);
    const first = events.filter((e) => e.hourId === h1);
    const second = events.filter((e) => e.hourId === h1 + 1);
    expect(second.length).toBeGreaterThan(0);
    const v1 = verifyTape(46630, h1, first.map((e) => e.encoded), undefined, closed[0]!.head);
    expect(v1.problems).toEqual([]);
    const v2 = verifyTape(46630, h1 + 1, second.map((e) => e.encoded));
    expect(v2.problems).toEqual([]);
    const carried = second.map((e) => decodeEvent(e.encoded)).filter((e) => e.kind === KIND_QUOTE && e.mode === MODE_CARRY);
    expect(carried.length).toBe(5);
    // the first tick of the new hour has a BTC mark thanks to the carried quotes
    const t = second.map((e) => decodeEvent(e.encoded)).find((e) => e.kind === KIND_TICK);
    if (!t || t.kind !== KIND_TICK) throw new Error();
    expect(t.tick.marks.find((m) => m.symbol === "BTC")!.status).toBe("OK");
  });
  test("a source that diverges halts the mark, and the halt replays", () => {
    const { events } = run(20, H0, (q) => (q.source === "arcus" && q.symbol === "BTC" ? { ...q, px: q.px * 102n / 100n } : q));
    const v = verifyTape(46630, hourOf(H0), events.map((e) => e.encoded));
    expect(v.ok).toBe(true);
    const ticks = events.map((e) => decodeEvent(e.encoded)).filter((e) => e.kind === KIND_TICK);
    const st = ticks.map((t) => (t.kind === KIND_TICK ? t.tick.marks.find((m) => m.symbol === "BTC")!.status : ""));
    expect(st.every((s) => s === "DIVERGED")).toBe(true);
  });
});
