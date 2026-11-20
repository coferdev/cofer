import { describe, expect, test } from "bun:test";
import { type Hex, concat } from "viem";
import { GameHost } from "../src/arena/engine/host";
import type { Order } from "../src/arena/engine/orders";
import { canonical, parseRules, rulesHash, type RulesJson } from "../src/arena/engine/rules";
import { encodeOrder } from "../src/arena/log/events";
import { type Open, replayLog } from "../src/arena/log/record";
import type { Mark } from "../src/arena/marks/median";
import { pubOf, signOrder } from "./arenaKeys";

const PX = (n: number) => BigInt(Math.round(n * 1e8));
const START = Date.parse("2026-11-21T10:00:00Z");
const TABLE = "0x00000000000000000000000000000000000000aa" as Hex;
const SEATS = ["0x00000000000000000000000000000000000000a1", "0x00000000000000000000000000000000000000a2"] as Hex[];
const RJ: RulesJson = {
  v: 1, mode: "FRIEND", markets: ["BTC", "ETH"], products: ["SPOT", "PERP"], leverageCap: { crypto: 10 },
  stack: "10000000000", fillDelayMs: 1000, minHoldSec: 60, feeBps: 5, funding: "none", lambda: "0.5",
  activity: { minFills: 1, minExposure: "0.2" },
  options: { premiumBudget: "0.25", spread: "0.03", sigma: {}, expiries: [] },
  marks: { sources: ["lighter", "arcus", "chainlink"], maxDivergence: "0.01", jumpGuard: "0.05" },
  collusion: { O: "0.6", rho: "-0.8", sync: 2 }, engine: "sha256:test",
};
const rules = parseRules(RJ);
const score = { stack: rules.stack, lambdaBps: rules.lambdaBps, minFills: rules.minFills, minExposureBps: rules.minExposureBps };
const open: Open = { chainId: 46630, table: TABLE, rulesHash: rulesHash(RJ), rulesJson: canonical(RJ), seats: SEATS, pubkeys: [pubOf(0), pubOf(1)], lockedAt: START, endAt: START + 600_000, lockBlock: 1n, tapeHours: [] };
const mk = (px: bigint, ts: number): Map<string, Mark> => new Map([["BTC", { symbol: "BTC", status: "OK", mark: px, used: ["lighter", "arcus"], venueFreshFromMs: ts - 100 } as Mark]]);
const order = (seat: Hex, n: bigint, x: Partial<Order> = {}): Order => ({ seat, nonce: n, kind: "MARKET", symbol: "BTC", product: "PERP", side: "BUY", qty: PX(0.1), leverage: 2n, clientId: `r${n}`, ...x });

describe("the game host", () => {
  test("a signed order is stamped, logged, filled at the next fresh tick, and reaches only its seat", () => {
    let clock = START + 1_500;
    const h = new GameHost(open, rules, score, () => clock);
    const tape = new Map<number, Map<string, Mark>>();
    h.tick(START + 1_000, (tape.set(START + 1_000, mk(PX(100_000), START + 1_000)), tape.get(START + 1_000)!));
    const o = order(SEATS[0]!, 1n);
    const a = h.place(encodeOrder(TABLE, o), signOrder(0, TABLE, o));
    expect(a).toMatchObject({ ok: true, ref: "r1", recvTs: START + 1_500 });
    let fills: unknown[] = [];
    for (let s = 2; s <= 4; s++) {
      const ts = START + s * 1000;
      tape.set(ts, mk(PX(100_000 + s), ts));
      clock = ts;
      fills = fills.concat(h.tick(ts, tape.get(ts)!));
    }
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ seat: SEATS[0]!, ev: "fill", ref: "r1", qty: PX(0.1) });
    // the host's log replays to itself
    const end = h.rec.end();
    expect(replayLog(46630, h.rec.log, rules, (ts) => tape.get(ts), end).problems).toEqual([]);
    expect(h.board(1)[0]!.seat).toBe(SEATS[0]!);
    expect(h.lb()[1]).toBe(SEATS[0]!.toLowerCase());
  });

  test("refused before the log: not canonical, another table, another seat's key, garbage, after close", () => {
    const h = new GameHost(open, rules, score, () => START + 2_000);
    const before = h.rec.log.length;
    const o = order(SEATS[0]!, 1n);
    const bytes = encodeOrder(TABLE, o);
    expect(h.place(concat([bytes, "0x00"]), signOrder(0, TABLE, o))).toEqual({ ok: false, error: "NOT_CANONICAL" });
    const other = "0x00000000000000000000000000000000000000ab" as Hex;
    expect(h.place(encodeOrder(other, o), signOrder(0, other, o))).toEqual({ ok: false, error: "OTHER_TABLE" });
    expect(h.place(bytes, signOrder(1, TABLE, o))).toEqual({ ok: false, error: "SIGNATURE" });
    const stranger = order("0x00000000000000000000000000000000000000ff", 1n);
    expect(h.place(encodeOrder(TABLE, stranger), signOrder(0, TABLE, stranger))).toEqual({ ok: false, error: "SIGNATURE" });
    expect(h.place("0x1234", "0x")).toEqual({ ok: false, error: "BAD_ORDER" });
    expect(h.rec.log.length).toBe(before);
    h.close();
    expect(h.place(bytes, signOrder(0, TABLE, o))).toEqual({ ok: false, error: "CLOSED" });
  });
});
