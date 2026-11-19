import { describe, expect, test } from "bun:test";
import type { Hex } from "viem";
import type { Order } from "../src/arena/engine/orders";
import { canonical, parseRules, rulesHash, type RulesJson } from "../src/arena/engine/rules";
import { sessionKeyHash } from "../src/arena/engine/session";
import { standingsTree } from "../src/arena/log/chain";
import { decodeLogEvent, encodeLogEvent } from "../src/arena/log/events";
import { type Open, Recorder, replayLog } from "../src/arena/log/record";
import type { Quote } from "../src/arena/marks/median";
import { TapeWriter, hourOf } from "../src/arena/marks/tape";
import { type OnChainGame, chainlinkQuotes, ticksFromTape, verifyGame } from "../src/arena/replay/verifyGame";
import { resultDigest } from "../src/arena/signer/result";
import { pubOf, put } from "./arenaKeys";

const PX = (n: number) => BigInt(Math.round(n * 1e8));
const START = Date.parse("2026-11-21T10:00:00Z");
const DUR = 300;
const CHAIN = 46630;
const TABLE = "0x00000000000000000000000000000000000000aa" as Hex;
const REG = "0x00000000000000000000000000000000000000bb" as Hex;
const BUILD = `0x${"ab".repeat(32)}` as Hex;
const ZERO = `0x${"0".repeat(64)}` as Hex;
const SEATS = ["0x00000000000000000000000000000000000000a1", "0x00000000000000000000000000000000000000a2", "0x00000000000000000000000000000000000000a3"] as Hex[];
const RJ: RulesJson = {
  v: 1, mode: "FRIEND", markets: ["BTC", "ETH"], products: ["SPOT", "PERP"], leverageCap: { crypto: 10 },
  stack: "10000000000", fillDelayMs: 1000, minHoldSec: 60, feeBps: 5, funding: "none", lambda: "0.5",
  activity: { minFills: 1, minExposure: "0.2" },
  options: { premiumBudget: "0.25", spread: "0.03", sigma: {}, expiries: [] },
  marks: { sources: ["lighter", "arcus", "chainlink"], maxDivergence: "0.01", jumpGuard: "0.05" },
  collusion: { O: "0.6", rho: "-0.8", sync: 2 }, engine: "sha256:test",
};

/** A real tape (three sources, BTC and ETH) and a game played on the marks it produced, as the services do live. */
function build() {
  const hour = hourOf(START);
  const tapeLines: Hex[] = [];
  let head: Hex = "0x";
  const w = new TapeWriter(CHAIN, (e) => {
    tapeLines.push(e.encoded);
    head = e.chainHash;
  }, () => {}, undefined, ["BTC", "ETH"]);
  const open: Open = {
    chainId: CHAIN, table: TABLE, rulesHash: rulesHash(RJ), rulesJson: canonical(RJ), seats: SEATS, pubkeys: [pubOf(0), pubOf(1), pubOf(2)],
    lockedAt: START, endAt: START + DUR * 1000 + 1000, lockBlock: 1n, tapeHours: [hour],
  };
  const r = new Recorder(open, parseRules(RJ));
  let n = 0n;
  const o = (seat: Hex, x: Partial<Order>): Order => ({ seat, nonce: ++n, kind: "MARKET", symbol: "BTC", product: "PERP", side: "BUY", clientId: `q${n}`, ...x });
  for (let s = 0; s < DUR; s++) {
    const t0 = START + s * 1000;
    const btc = 100_000 + s * 3;
    const eth = 4_000 - s / 5;
    const qs: Quote[] = [
      { source: "lighter", symbol: "BTC", px: PX(btc), recvMs: t0 + 100, srcTs: 0, flags: 0 },
      { source: "arcus", symbol: "BTC", px: PX(btc + 2), recvMs: t0 + 130, srcTs: 0, flags: 0 },
      { source: "lighter", symbol: "ETH", px: PX(eth), recvMs: t0 + 110, srcTs: 0, flags: 0 },
      { source: "arcus", symbol: "ETH", px: PX(eth + 0.1), recvMs: t0 + 140, srcTs: 0, flags: 0 },
    ];
    if (s % 30 === 0)
      qs.push({ source: "chainlink", symbol: "BTC", px: PX(btc + 1), recvMs: t0 + 150, srcTs: Math.floor(t0 / 1000) - 20, flags: 0, round: { roundId: 1000n + BigInt(s), answer: PX(btc + 1), decimals: 8, multiplier: 10n ** 18n } });
    for (const q of qs) w.quote(q);
    const ts = t0 + 1000;
    const marks = new Map(w.tick(ts).map((m) => [m.symbol as string, m]));
    if (s === 2) put(r, 0, o(SEATS[0]!, { qty: PX(0.3), leverage: 5n }), ts + 3);
    if (s === 3) put(r, 1, o(SEATS[1]!, { symbol: "ETH", qty: PX(4), leverage: 2n }), ts + 3);
    if (s === 4) put(r, 2, o(SEATS[2]!, { side: "SELL", symbol: "ETH", qty: PX(1), leverage: 1n }), ts + 3);
    r.tick(ts, marks);
  }
  const pr = parseRules(RJ);
  const { standings, head: logHead } = r.close({ stack: pr.stack, lambdaBps: pr.lambdaBps, minFills: pr.minFills, minExposureBps: pr.minExposureBps });
  const posted = {
    round: 0, logHead, eventsRoot: r.chain.eventsTree().root, standingsRoot: standingsTree(CHAIN, TABLE, standings).root, logURI: "ipfs://log",
    podium: standings.slice(0, 2).map((x) => x.seat as Hex), payoutRoot: ZERO, totalPayout: 0n,
  };
  const digest = resultDigest(CHAIN, REG, TABLE, rulesHash(RJ), { ...posted, engineBuild: BUILD });
  const chain: OnChainGame = {
    chainId: CHAIN, registry: REG, table: TABLE, rulesHash: rulesHash(RJ), seats: SEATS,
    keys: new Map(SEATS.map((a, i) => [a.toLowerCase(), sessionKeyHash(pubOf(i))])), podiumSize: 2,
    posted: { ...posted, digest }, tapeHeads: new Map([[hour, head]]),
  };
  return { chain, log: r.log, tape: new Map([[hour, tapeLines]]), hour };
}

const statuses = (o: ReturnType<typeof verifyGame>) => Object.fromEntries(o.steps.map((s) => [s.name, s.status]));

describe("arena-replay verify", () => {
  test("an honest game passes every step, the digest included; quotes SKIP without an RPC", () => {
    const g = build();
    const out = verifyGame(g.chain, { log: g.log, tape: g.tape, engineBuild: BUILD });
    expect(statuses(out)).toEqual({ chain: "PASS", tape: "PASS", quotes: "SKIP", keys: "PASS", replay: "PASS", result: "PASS" });
    expect(out.ok).toBe(true);
    expect(chainlinkQuotes(g.tape.values()).length).toBe(10);
    expect(verifyGame(g.chain, { log: g.log, tape: g.tape, quoteProblems: [] }).steps[2]!.status).toBe("PASS");
  });

  test("the ticks read back from the tape are the marks the game was played on", () => {
    const g = build();
    const ticks = ticksFromTape(g.tape.values());
    expect(ticks.size).toBe(DUR);
    const pr = parseRules(RJ);
    const rp = replayLog(CHAIN, g.log, pr, (ts) => ticks.get(ts), g.chain.posted.logHead, { stack: pr.stack, lambdaBps: pr.lambdaBps, minFills: pr.minFills, minExposureBps: pr.minExposureBps });
    expect(rp.problems).toEqual([]);
  });

  test("each kind of wrong input fails its own step", () => {
    const g = build();
    const run = (c: Partial<OnChainGame>, f: Partial<Parameters<typeof verifyGame>[1]> = {}) => statuses(verifyGame({ ...g.chain, ...c }, { log: g.log, tape: g.tape, engineBuild: BUILD, ...f }));

    expect(run({ rulesHash: `0x${"11".repeat(32)}` }).chain).toBe("FAIL");
    expect(run({ tapeHeads: new Map([[g.hour, `0x${"22".repeat(32)}` as Hex]]) }).tape).toBe("FAIL");
    expect(run({}, { tape: new Map() }).tape).toBe("FAIL");
    expect(run({}, { quoteProblems: ["BTC round 1000: tape 1 @0, chain 2 @0"] }).quotes).toBe("FAIL");
    const keys = new Map(g.chain.keys);
    keys.set(SEATS[2]!.toLowerCase(), sessionKeyHash(pubOf(9)));
    expect(run({ keys }).keys).toBe("FAIL");
    expect(run({ posted: { ...g.chain.posted, podium: [...g.chain.posted.podium].reverse() } }).result).toBe("FAIL");
    expect(run({}, { engineBuild: `0x${"cd".repeat(32)}` }).result).toBe("FAIL");
    expect(run({ posted: { ...g.chain.posted, logHead: `0x${"33".repeat(32)}` } }).replay).toBe("FAIL");

    // one fill price changed in the published log: the replay disagrees
    const fi = g.log.findIndex((x) => decodeLogEvent(x).type === "Fill");
    const f = decodeLogEvent(g.log[fi]!);
    const p = [...f.payload];
    p[5] = (p[5] as bigint) + 1n;
    const log = [...g.log];
    log[fi] = encodeLogEvent({ ...f, payload: p });
    const s = run({}, { log });
    expect(s.replay).toBe("FAIL");
    expect(s.keys).toBe("PASS");
  }, 30_000);
});
