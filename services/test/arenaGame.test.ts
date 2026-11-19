import { describe, expect, test } from "bun:test";
import type { Mark } from "../src/arena/marks/median";
import type { Symbol } from "../src/arena/marks/markets";
import { type GameEmitted, type GameEvent, finish, newGame, step } from "../src/arena/engine/game";
import { type Order, PRACTICE_RULES } from "../src/arena/engine/orders";
import { type ScoreInput, type ScoreRules, rank, scoreOf, seasonPoints } from "../src/arena/scoring/score";

const PX = (n: number) => BigInt(Math.round(n * 1e8));
const START = Date.parse("2026-11-21T10:00:00Z"); // a Saturday: crypto only
const RULES = { ...PRACTICE_RULES, markets: ["BTC", "ETH"] as Symbol[], optionMarkets: ["BTC", "ETH"] as Symbol[] };
const mk = (symbol: Symbol, px: bigint, ts: number): Mark => ({ symbol, status: "OK", mark: px, used: ["lighter", "arcus", "chainlink"], venueFreshFromMs: ts });

/** A deterministic path: BTC drifts down 20 per second, ETH up 0.5. */
function events(seconds: number): GameEvent[] {
  const ev: GameEvent[] = [];
  let seq = 0;
  let n = 0n;
  const o = (seat: string, x: Partial<Order>): Order => ({ seat, nonce: ++n, kind: "MARKET", symbol: "BTC", product: "PERP", side: "BUY", clientId: `${seat}-${n}`, ...x });
  for (let s = 1; s <= seconds; s++) {
    const ts = START + s * 1000;
    if (s === 5) ev.push({ t: "OrderIn", seq: ++seq, recvTs: ts + 10, order: o("A", { qty: PX(1), leverage: 20n }) }); // big long, 20x
    if (s === 6) ev.push({ t: "OrderIn", seq: ++seq, recvTs: ts + 10, order: o("B", { side: "SELL", qty: PX(0.05), leverage: 2n }) });
    if (s === 7) ev.push({ t: "OrderIn", seq: ++seq, recvTs: ts + 10, order: o("C", { symbol: "ETH", product: "SPOT", qty: PX(0.5) }) });
    if (s === 8) ev.push({ t: "OrderIn", seq: ++seq, recvTs: ts + 10, order: o("C", { kind: "OPT_BUY", product: "OPTION", option: { type: "PUT", strike: PX(100_000), expiry: START + 3_600_000, contracts: 5n } }) });
    ev.push({ t: "Tick", seq: ++seq, ts, marks: new Map([["BTC", mk("BTC", PX(100_000 - 20 * s), ts)], ["ETH", mk("ETH", PX(4_000 + s / 2), ts)]]) });
  }
  return ev;
}

const json = (x: unknown) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v instanceof Map ? [...v] : v));

function play(seconds: number) {
  const g = newGame(RULES, ["A", "B", "C", "D"], START, START + 2 * 3_600_000);
  const out: GameEmitted[] = [];
  for (const e of events(seconds)) out.push(...step(g, e));
  return { g, out };
}

describe("arena game fold", () => {
  test("lists the hourly and game-end expiries at the first valid tick", () => {
    const { out } = play(3);
    const l = out.filter((e) => e.t === "OptionList") as { sym: string; expiry: number }[];
    // BTC and ETH: 11:00 (hourly), 12:00 is a 4 h expiry listed 4 h before (so from the start), game end 12:00 too
    expect(l.map((x) => `${x.sym} ${new Date(x.expiry).toISOString().slice(11, 16)}`)).toEqual(["BTC 11:00", "BTC 12:00", "ETH 11:00", "ETH 12:00"]);
  });

  test("a 20x long is eliminated when equity falls to maintenance; it sends nothing after", () => {
    const { g, out } = play(400);
    const el = out.filter((e) => e.t === "Eliminate") as { seat: string; ts: number }[];
    expect(el.map((e) => e.seat)).toEqual(["A"]);
    const a = g.book.seats.get("A")!.ledger;
    expect(a.perps.size).toBe(0);
    expect(a.cash).toBeGreaterThanOrEqual(0n);
    expect(a.eliminatedAt).toBe(el[0]!.ts);
  });

  test("the option bought by C settles at expiry at the first valid mark at or after it", () => {
    const { out } = play(3_700);
    const st = out.filter((e) => e.t === "OptionSettle") as { sym: string; px: bigint; credits: [string, bigint][] }[];
    const btc11 = st.find((s) => s.sym === "BTC")!;
    expect(btc11.px).toBe(PX(100_000 - 20 * 3_600));
    // 5 contracts × 0.01 BTC × (100,000 − 28,000) = 3,600 chips
    expect(btc11.credits).toEqual([["C", 3_600_000_000n]]);
  });

  test("replay gives the same events and state, byte for byte", () => {
    const a = play(900);
    const b = play(900);
    expect(json(b.out)).toBe(json(a.out));
    expect(json([...b.g.samples])).toBe(json([...a.g.samples]));
  });

  test("finish closes everything at the last valid mark; seats with no trades keep the stack", () => {
    const { g } = play(600);
    const fin = finish(g, START + 2 * 3_600_000);
    expect(fin.get("D")).toBe(RULES.stack);
    expect(fin.get("B")!).toBeGreaterThan(RULES.stack); // short while BTC fell
    for (const s of g.book.seats.values()) expect(s.ledger.perps.size + s.ledger.spot.size + s.options.size).toBe(0);
  });
});

describe("arena scoring", () => {
  const R: ScoreRules = { stack: 10_000_000_000n, lambdaBps: 5_000n, minFills: 5, minExposureBps: 2_000n, durationMs: 3_600_000 };
  const x = (seat: string, index: number, eq: number, dd: number, o: Partial<ScoreInput> = {}): ScoreInput => ({
    seat, index, finalEquity: BigInt(eq) * 1_000_000n, maxDdBps: BigInt(dd), fills: 10, exposedMs: 3_600_000, eliminatedAt: null, ...o,
  });

  test("S = R − λ·D at 1e6", () => {
    expect(scoreOf(x("a", 0, 12_000, 1_000), R)).toBe(200_000n - 50_000n);
    expect(scoreOf(x("a", 0, 9_000, 1_500), R)).toBe(-100_000n - 75_000n);
  });

  test("tiers: active survivors, then inactive survivors, then eliminated by time (later higher); ties by D then index", () => {
    const st = rank([
      x("inactive", 0, 20_000, 0, { fills: 1 }),
      x("elimEarly", 1, 0, 10_000, { eliminatedAt: 100 }),
      x("elimLate", 2, 0, 10_000, { eliminatedAt: 200 }),
      x("best", 3, 13_000, 500),
      x("tieLowD", 5, 11_000, 0),
      x("tieHighIndex", 6, 11_000, 0),
      x("tieHighD", 4, 11_100, 200), // S = 0.11 − 0.01 = 0.10, same as the two above
    ], R);
    expect(st.map((s) => s.seat)).toEqual(["best", "tieLowD", "tieHighIndex", "tieHighD", "inactive", "elimLate", "elimEarly"]);
    expect(st[0]!.rank).toBe(1);
  });

  test("a collusion flag gives both seats the lower score; an eliminated counterpart counts as −1", () => {
    const st = rank([x("a", 0, 15_000, 0), x("b", 1, 0, 10_000, { eliminatedAt: 50 }), x("c", 2, 10_500, 0)], R, [["a", "b"]]);
    const a = st.find((s) => s.seat === "a")!;
    expect(a.score1e6).toBe(-1_000_000n);
    expect(a.flags).toBe(1);
    expect(st.map((s) => s.seat)).toEqual(["c", "a", "b"]);
  });

  test("season points", () => {
    expect([1, 2, 3, 4, 5].map((r) => seasonPoints(r, 5))).toEqual([125, 90, 60, 25, 0]);
    expect([seasonPoints(1, 2), seasonPoints(2, 2)]).toEqual([60, 20]);
    expect(seasonPoints(2, 3)).toBe(50 + 15);
  });
});
