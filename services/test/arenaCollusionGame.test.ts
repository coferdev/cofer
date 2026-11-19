import { describe, expect, test } from "bun:test";
import type { Hex } from "viem";
import type { Order } from "../src/arena/engine/orders";
import { canonical, parseRules, rulesHash, type RulesJson } from "../src/arena/engine/rules";
import { decodeLogEvent } from "../src/arena/log/events";
import { type Open, Recorder, replayLog } from "../src/arena/log/record";
import type { Mark } from "../src/arena/marks/median";
import { FLAG_COLLUSION } from "../src/arena/scoring/score";
import { pubOf, put } from "./arenaKeys";

const PX = (n: number) => BigInt(Math.round(n * 1e8));
const START = Date.parse("2026-11-21T10:00:00Z");
const DUR = 30 * 60;
const SEATS = ["0x00000000000000000000000000000000000000a1", "0x00000000000000000000000000000000000000a2", "0x00000000000000000000000000000000000000a3"] as Hex[];
const RJ: RulesJson = {
  v: 1, mode: "FRIEND", markets: ["BTC", "ETH"], products: ["SPOT", "PERP"], leverageCap: { crypto: 10 },
  stack: "10000000000", fillDelayMs: 1000, minHoldSec: 60, feeBps: 5, funding: "none", lambda: "0.5",
  activity: { minFills: 1, minExposure: "0.2" },
  options: { premiumBudget: "0.25", spread: "0.03", sigma: {}, expiries: [] },
  marks: { sources: ["lighter", "arcus", "chainlink"], maxDivergence: "0.01", jumpGuard: "0.05" },
  collusion: { O: "0.6", rho: "-0.8", sync: 2 }, engine: "sha256:test",
};
const rules = parseRules(RJ);
const mk = (symbol: "BTC" | "ETH", px: bigint, ts: number): Mark => ({ symbol, status: "OK", mark: px, used: ["lighter", "arcus"], venueFreshFromMs: ts - 100 });
const tape = new Map<number, Map<string, Mark>>();
for (let s = 1; s <= DUR; s++) {
  const ts = START + s * 1000;
  const wiggle = 40 * Math.sin(s / 7);
  tape.set(ts, new Map([["BTC", mk("BTC", PX(100_000 + s * 4 + wiggle), ts)], ["ETH", mk("ETH", PX(4_000 + Math.sin(s / 11) * 3), ts)]]));
}
const score = { stack: rules.stack, lambdaBps: rules.lambdaBps, minFills: rules.minFills, minExposureBps: rules.minExposureBps };
const open: Open = { chainId: 46630, table: "0x00000000000000000000000000000000000000aa", rulesHash: rulesHash(RJ), rulesJson: canonical(RJ), seats: SEATS, pubkeys: [pubOf(0), pubOf(1), pubOf(2)], lockedAt: START, endAt: START + DUR * 1000 + 1000, lockBlock: 1n, tapeHours: [] };

function play(withPair: boolean) {
  const r = new Recorder(open, rules);
  let n = 0n;
  const o = (seat: Hex, x: Partial<Order>): Order => ({ seat, nonce: ++n, kind: "MARKET", symbol: "BTC", product: "PERP", side: "BUY", clientId: `c${n}`, ...x });
  for (const [ts, m] of tape) {
    const s = (ts - START) / 1000;
    if (s === 5) put(r, 0, o(SEATS[0]!, { qty: PX(0.9), leverage: 10n }), ts + 3); // max long
    if (s === 20 && withPair) put(r, 1, o(SEATS[1]!, { side: "SELL", qty: PX(0.9), leverage: 10n }), ts + 3); // max short, 15 s later
    if (s === 20 && !withPair) put(r, 1, o(SEATS[1]!, { symbol: "ETH", qty: PX(2), leverage: 2n }), ts + 3); // an unrelated trade
    if (s === 40) put(r, 2, o(SEATS[2]!, { symbol: "ETH", qty: PX(1), leverage: 1n }), ts + 3);
    r.tick(ts, m);
  }
  return { r, ...r.close(score) };
}

describe("collusion in a played game", () => {
  test("max long and max short opened together, one wiped out: flagged, logged, both take the lower score", () => {
    const { r, standings } = play(true);
    const elim = r.log.map((x) => decodeLogEvent(x)).find((e) => e.type === "Eliminate");
    expect((elim?.payload[0] as string).toLowerCase()).toBe(SEATS[1]!);
    const flags = r.log.map((x) => decodeLogEvent(x)).filter((e) => e.type === "Flag");
    expect(flags).toHaveLength(1);
    expect(flags[0]!.payload[0]).toBe("COLLUSION");
    expect((flags[0]!.payload[1] as string[]).map((a) => a.toLowerCase())).toEqual([SEATS[0]!, SEATS[1]!]);
    const [oBps, , sync, held] = flags[0]!.payload[2] as bigint[];
    expect(oBps! >= 6_000n).toBe(true);
    expect(sync).toBe(1n);
    expect(held).toBe(1n);
    const a = standings.find((x) => x.seat === SEATS[0]!)!;
    const b = standings.find((x) => x.seat === SEATS[1]!)!;
    expect(a.flags & FLAG_COLLUSION).toBe(FLAG_COLLUSION);
    expect(b.flags & FLAG_COLLUSION).toBe(FLAG_COLLUSION);
    expect(a.score1e6).toBe(b.score1e6);
    expect(standings[0]!.seat).toBe(SEATS[2]!); // the honest seat wins
  });

  test("the same long with no opposite counterpart is not flagged", () => {
    const { r, standings } = play(false);
    expect(r.log.map((x) => decodeLogEvent(x)).filter((e) => e.type === "Flag")).toHaveLength(0);
    expect(standings[0]!.seat).toBe(SEATS[0]!);
    expect(standings.every((s) => s.flags === 0)).toBe(true);
  });

  test("the replay finds the same flag on its own", () => {
    const { r, head } = play(true);
    const rp = replayLog(46630, r.log, rules, (ts) => tape.get(ts), head, score);
    expect(rp.problems).toEqual([]);
  });
});
