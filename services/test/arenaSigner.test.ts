import { describe, expect, test } from "bun:test";
import { keccak256, toBytes } from "viem";
import { resultDigest } from "../src/arena/signer/result";

const k = (s: string) => keccak256(toBytes(s));

describe("arena result digest", () => {
  test("matches ResultRegistry.resultDigest (the vector in contracts/test/arena/ResultDigestVector.t.sol)", () => {
    const d = resultDigest(4663, "0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f", "0x2e234DAe75C793f67A35089C9d99245E1C58470b", k("rules-json-v1"), {
      round: 1, logHead: k("log"), eventsRoot: k("events"), standingsRoot: k("standings"),
      podium: ["0x00000000000000000000000000000000000000B1", "0x00000000000000000000000000000000000000b2"],
      payoutRoot: k("payout"), totalPayout: 123_000_000n, engineBuild: k("engine"), logURI: "ipfs://bafy-log",
    });
    expect(d).toBe("0x0c7e305cc718e437969c8b17b7c5fcd4d38331286f8a80c7f2dcfa9b9de90775");
  });
});

import type { Hex } from "viem";
import type { Mark } from "../src/arena/marks/median";
import type { Symbol } from "../src/arena/marks/markets";
import type { Order } from "../src/arena/engine/orders";
import { canonical, parseRules, rulesHash, type RulesJson } from "../src/arena/engine/rules";
import { standingsTree } from "../src/arena/log/chain";
import { type Open, Recorder } from "../src/arena/log/record";
import { checkResult, type SignRequest } from "../src/arena/signer/verify";
import { decodeLogEvent, encodeLogEvent } from "../src/arena/log/events";

describe("arena signer check", () => {
  const PX = (n: number) => BigInt(Math.round(n * 1e8));
  const START = Date.parse("2026-11-21T10:00:00Z");
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
  const TABLE = "0x00000000000000000000000000000000000000aa" as Hex;
  const REG = "0x00000000000000000000000000000000000000bb" as Hex;
  const BUILD = k("engine-build");
  const tape = new Map<number, Map<string, Mark>>();
  const DUR = 600;
  const mk = (symbol: Symbol, px: bigint, ts: number): Mark => ({ symbol, status: "OK", mark: px, used: ["lighter", "arcus"], venueFreshFromMs: ts - 100 });
  for (let s = 1; s <= DUR; s++) {
    const ts = START + s * 1000;
    tape.set(ts, new Map([["BTC", mk("BTC", PX(100_000 + s * 3), ts)], ["ETH", mk("ETH", PX(4_000 - s / 5), ts)]]));
  }
  function game() {
    const open: Open = { chainId: 4663, table: TABLE, rulesHash: rulesHash(RJ), rulesJson: canonical(RJ), seats: SEATS, pubkeys: ["0x01", "0x02", "0x03"], lockedAt: START, endAt: START + DUR * 1000 + 1000, lockBlock: 1n, tapeHours: [] };
    const r = new Recorder(open, rules);
    let n = 0n;
    const o = (seat: Hex, x: Partial<Order>): Order => ({ seat, nonce: ++n, kind: "MARKET", symbol: "BTC", product: "PERP", side: "BUY", clientId: `q${n}`, ...x });
    for (const [ts, m] of tape) {
      const s = (ts - START) / 1000;
      if (s === 2) r.order(o(SEATS[0]!, { qty: PX(0.3), leverage: 5n }), "0x11", ts + 3); // long BTC while it rises
      if (s === 3) r.order(o(SEATS[1]!, { symbol: "ETH", qty: PX(4), leverage: 2n }), "0x22", ts + 3); // long ETH while it falls
      if (s === 4) r.order(o(SEATS[2]!, { side: "SELL", symbol: "ETH", qty: PX(1), leverage: 1n }), "0x33", ts + 3);
      r.tick(ts, m);
    }
    const score = { stack: rules.stack, lambdaBps: rules.lambdaBps, minFills: rules.minFills, minExposureBps: rules.minExposureBps };
    const { standings, head } = r.close(score);
    return { r, standings, head };
  }
  const request = (): SignRequest => {
    const { r, standings, head } = game();
    return {
      chainId: 4663, registry: REG, table: TABLE, onChainRulesHash: rulesHash(RJ), rulesJson: RJ, log: r.log, ticks: (ts) => tape.get(ts),
      podiumSize: 2, engineBuild: BUILD,
      proposed: {
        round: 0, logHead: head, eventsRoot: r.chain.eventsTree().root, standingsRoot: standingsTree(4663, TABLE, standings).root,
        podium: standings.slice(0, 2).map((s) => s.seat as Hex), payoutRoot: `0x${"0".repeat(64)}`, totalPayout: 0n, engineBuild: BUILD, logURI: "ipfs://x",
      },
    };
  };

  test("an honest result passes and gives the digest to sign; the podium is the replay's top two", () => {
    const q = request();
    expect(q.proposed.podium.map((a) => a.toLowerCase())).toEqual([SEATS[0]!, SEATS[2]!]);
    const c = checkResult(q);
    expect(c.ok).toBe(true);
    if (c.ok) expect(c.digest).toBe(resultDigest(4663, REG, TABLE, rulesHash(RJ), q.proposed));
  });

  test("a swapped podium, a wrong root, other rules, or another engine build: nothing to sign", () => {
    const q = request();
    const bad = (p: Partial<SignRequest["proposed"]>, extra: Partial<SignRequest> = {}) => checkResult({ ...q, ...extra, proposed: { ...q.proposed, ...p } });
    expect(bad({ podium: [...q.proposed.podium].reverse() }).ok).toBe(false);
    expect(bad({ standingsRoot: k("x") }).ok).toBe(false);
    expect(bad({ eventsRoot: k("x") }).ok).toBe(false);
    expect(bad({ logHead: k("x") }).ok).toBe(false);
    expect(bad({ engineBuild: k("other") }).ok).toBe(false);
    expect(bad({}, { onChainRulesHash: k("other rules") }).ok).toBe(false);
    expect(bad({ totalPayout: 1n }).ok).toBe(false);
  });

  test("a log with one changed fill is refused even if the roots were rebuilt to match it", () => {
    const q = request();
    const fi = q.log.findIndex((x) => decodeLogEvent(x).type === "Fill");
    const f = decodeLogEvent(q.log[fi]!);
    const p = [...f.payload];
    p[5] = (p[5] as bigint) + 1n;
    const log = [...q.log];
    log[fi] = encodeLogEvent({ ...f, payload: p });
    const c = checkResult({ ...q, log });
    expect(c.ok).toBe(false);
  });
});
