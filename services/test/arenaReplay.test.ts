import { describe, expect, test } from "bun:test";
import type { Hex } from "viem";
import type { Mark } from "../src/arena/marks/median";
import type { Symbol } from "../src/arena/marks/markets";
import { type Order, PRACTICE_RULES } from "../src/arena/engine/orders";
import { canonical, parseRules, rulesHash, type RulesJson } from "../src/arena/engine/rules";
import { decodeLogEvent, encodeLogEvent } from "../src/arena/log/events";
import { type Open, Recorder, replayLog } from "../src/arena/log/record";
import { pubOf, put } from "./arenaKeys";

const PX = (n: number) => BigInt(Math.round(n * 1e8));
const START = Date.parse("2026-11-21T10:59:00Z");
const SEATS = ["0x00000000000000000000000000000000000000a1", "0x00000000000000000000000000000000000000a2"] as Hex[];
const RULES_JSON: RulesJson = {
  v: 1, mode: "FRIEND", markets: ["BTC", "ETH"], products: ["SPOT", "PERP", "OPTION"], leverageCap: { crypto: 10 },
  stack: "10000000000", fillDelayMs: 1000, minHoldSec: 60, feeBps: 5, funding: "none", lambda: "0.5",
  activity: { minFills: 5, minExposure: "0.2" },
  options: { premiumBudget: "0.25", spread: "0.03", sigma: { BTC: "0.52", ETH: "0.68" }, expiries: ["1h", "4h", "end"] },
  marks: { sources: ["lighter", "arcus", "chainlink"], maxDivergence: "0.01", jumpGuard: "0.05" },
  collusion: { O: "0.6", rho: "-0.8", sync: 2 }, engine: "sha256:test",
};
const rules = parseRules(RULES_JSON);
const open: Open = {
  chainId: 4663, table: "0x00000000000000000000000000000000000000aa", rulesHash: rulesHash(RULES_JSON), rulesJson: canonical(RULES_JSON),
  seats: SEATS, pubkeys: [pubOf(0), pubOf(1)], lockedAt: START, endAt: START + 24 * 3_600_000, lockBlock: 123n, tapeHours: [],
};
const mk = (symbol: Symbol, px: bigint, ts: number): Mark => ({ symbol, status: "OK", mark: px, used: ["lighter", "arcus", "chainlink"], venueFreshFromMs: ts - 300 });
const tape = new Map<number, Map<string, Mark>>();
for (let s = 1; s <= 600; s++) {
  const ts = START + s * 1000;
  tape.set(ts, new Map([["BTC", mk("BTC", PX(100_000 + 30 * Math.sin(s / 20) - s), ts)], ["ETH", mk("ETH", PX(4_000 + s / 10), ts)]]));
}

function record(): Recorder {
  const r = new Recorder(open, rules);
  let n = 0n;
  const o = (seat: Hex, x: Partial<Order>): Order => ({ seat: seat.toLowerCase(), nonce: ++n, kind: "MARKET", symbol: "BTC", product: "PERP", side: "BUY", clientId: `k${n}`, ...x });
  for (const [ts, m] of tape) {
    const s = (ts - START) / 1000;
    if (s === 3) put(r, 0, o(SEATS[0]!, { qty: PX(0.2), leverage: 5n }), ts + 17);
    if (s === 4) put(r, 1, o(SEATS[1]!, { kind: "LIMIT", side: "SELL", symbol: "ETH", qty: PX(2), limitPx: PX(4_020), leverage: 3n }), ts + 5);
    if (s === 20) put(r, 0, o(SEATS[0]!, { kind: "STOP", side: "SELL", triggerPx: PX(99_800) }), ts + 1);
    if (s === 70) put(r, 1, o(SEATS[1]!, { kind: "OPT_BUY", product: "OPTION", option: { type: "CALL", strike: PX(100_000), expiry: Date.parse("2026-11-21T12:00:00Z"), contracts: 3n } }), ts + 9);
    if (s === 71) put(r, 1, o(SEATS[1]!, { qty: PX(1), leverage: 50n }), ts + 9); // refused: over the cap
    r.tick(ts, m);
  }
  r.end();
  return r;
}

describe("arena record and replay", () => {
  test("rules: canonical JSON is key-sorted and stable; parse gives the engine values", () => {
    expect(canonical({ b: 1, a: { d: "x", c: [2, 1] } })).toBe('{"a":{"c":[2,1],"d":"x"},"b":1}');
    expect(rules.leverageCap.crypto).toBe(10n);
    expect(rules.premiumBudgetBps).toBe(2_500n);
    expect(rules.lambdaBps).toBe(5_000n);
    expect(rules.minHoldMs).toBe(60_000);
    expect(() => parseRules({ ...RULES_JSON, markets: ["DOGE"] })).toThrow();
  });

  test("a recorded game replays to the same log and head; ticks are referenced in ranges", () => {
    const r = record();
    const types = r.log.map((x) => decodeLogEvent(x).type);
    expect(types[0]).toBe("GameOpen");
    expect(types).toContain("Fill");
    expect(types).toContain("OptionFill");
    expect(types).toContain("OrderReject");
    expect(types.filter((t) => t === "TickRef").length).toBeLessThan(40); // 600 ticks, few ranges
    const res = replayLog(4663, r.log, rules, (ts) => tape.get(ts), r.chain.head);
    expect(res.problems).toEqual([]);
    expect(res.ok).toBe(true);
  });

  test("a changed output (a fill price) is found, and so is a log replayed on another chain", () => {
    const r = record();
    const i = r.log.findIndex((x) => decodeLogEvent(x).type === "Fill");
    const f = decodeLogEvent(r.log[i]!);
    const p = [...f.payload];
    p[5] = (p[5] as bigint) - 1n;
    const bad = [...r.log];
    bad[i] = encodeLogEvent({ ...f, payload: p });
    const res = replayLog(4663, bad, rules, (ts) => tape.get(ts));
    expect(res.ok).toBe(false);
    expect(res.problems[0]).toContain(`#${i}`);
    expect(replayLog(46630, r.log, rules, (ts) => tape.get(ts), r.chain.head).ok).toBe(false);
  });

  test("a changed tape tick changes the outcome and is found", () => {
    const r = record();
    const t2 = new Map(tape);
    const ts = START + 5_000;
    t2.set(ts, new Map([["BTC", mk("BTC", PX(100_500), ts)], ["ETH", mk("ETH", PX(4_000), ts)]]));
    expect(replayLog(4663, r.log, rules, (x) => t2.get(x)).ok).toBe(false);
  });
});
