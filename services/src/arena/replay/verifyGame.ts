/**
 * `arena-replay verify` without the network (spec §4.8): everything read from chain and downloaded is passed in, and
 * each step reports PASS, FAIL or SKIP. The signers run the same checks (signer/verify.ts) before they sign.
 *   1. chain    the rules in GameOpen hash to the table's rulesHash; GameOpen's seats are the table's seats
 *   2. tape     every tape hour the game used chains to the tapeHead anchored in the registry
 *   3. quotes   every Chainlink quote matches its on-chain round (needs an RPC; SKIP when not given)
 *   4. keys     every session key hashes to the seat's on-chain sessionKeyHash, every OrderIn signature verifies
 *   5. replay   the engine folded over the log gives exactly the posted events, ending at the posted logHead
 *   6. result   eventsRoot, standingsRoot, podium or payoutRoot are the replay's; with the engine build, the digest
 */
import type { Hex } from "viem";
import { parseRules, rulesHash, type RulesJson } from "../engine/rules";
import { keyProblems, orderSigProblem } from "../engine/session";
import { payoutTree, standingsTree } from "../log/chain";
import { decodeLogEvent } from "../log/events";
import { type Ticks, replayLog } from "../log/record";
import type { Mark } from "../marks/median";
import { KIND_QUOTE, KIND_TICK, decodeEvent, verifyTape } from "../marks/tape";
import type { Standing } from "../scoring/score";
import { resultDigest } from "../signer/result";

export type StepStatus = "PASS" | "FAIL" | "SKIP";
export interface Step {
  name: string;
  status: StepStatus;
  detail: string[];
}

/** What the table and the registry say (read from chain). */
export interface OnChainGame {
  chainId: number;
  registry: Hex;
  table: Hex;
  rulesHash: Hex;
  seats: Hex[];
  /** seat → sessionKeyHash */
  keys: Map<string, Hex>;
  /** FRIEND: payoutBps.length; FREEROLL: 0 */
  podiumSize: number;
  posted: {
    round: number;
    digest: Hex;
    logHead: Hex;
    eventsRoot: Hex;
    standingsRoot: Hex;
    logURI: string;
    podium: Hex[];
    payoutRoot: Hex;
    totalPayout: bigint;
  };
  /** hour → anchored tapeHead (zero when not anchored) */
  tapeHeads: Map<number, Hex>;
}

export interface GameFiles {
  log: Hex[];
  /** hour → encoded tape events, in order */
  tape: Map<number, Hex[]>;
  payouts?: { index: number; account: Hex; amount: bigint }[];
  engineBuild?: Hex;
  /** Chainlink check result, when an RPC was used: the list of mismatches. */
  quoteProblems?: string[];
  flaggedPairs?: [string, string][];
}

export interface VerifyOut {
  ok: boolean;
  steps: Step[];
  standings?: Standing[];
}

const ZERO = `0x${"0".repeat(64)}` as Hex;
const step = (name: string, problems: string[], pass: string, skip?: string): Step =>
  skip !== undefined ? { name, status: "SKIP", detail: [skip] } : problems.length ? { name, status: "FAIL", detail: problems.slice(0, 20) } : { name, status: "PASS", detail: [pass] };
const lc = (a: string) => a.toLowerCase();

/** The ticks of verified tape hours, by second. */
export function ticksFromTape(hours: Iterable<Hex[]>): Map<number, Map<string, Mark>> {
  const out = new Map<number, Map<string, Mark>>();
  for (const lines of hours)
    for (const e of lines) {
      const ev = decodeEvent(e);
      if (ev.kind === KIND_TICK) out.set(ev.tick.tsMs, new Map(ev.tick.marks.map((m) => [m.symbol, m])));
    }
  return out;
}

/** Every Chainlink quote on the given tape hours (unique rounds): the inputs to the on-chain round check. */
export function chainlinkQuotes(hours: Iterable<Hex[]>) {
  const seen = new Map<string, { symbol: string; roundId: bigint; answer: bigint; updatedAt: number }>();
  for (const lines of hours)
    for (const e of lines) {
      const ev = decodeEvent(e);
      if (ev.kind !== KIND_QUOTE || ev.quote.source !== "chainlink" || !ev.quote.round) continue;
      const q = ev.quote;
      seen.set(`${q.symbol}:${q.round!.roundId}:${q.round!.answer}:${q.srcTs}`, { symbol: q.symbol, roundId: q.round!.roundId, answer: q.round!.answer, updatedAt: q.srcTs });
    }
  return [...seen.values()];
}

export function verifyGame(c: OnChainGame, f: GameFiles): VerifyOut {
  const steps: Step[] = [];
  if (!f.log.length) return { ok: false, steps: [{ name: "log", status: "FAIL", detail: ["the log is empty"] }] };
  const first = decodeLogEvent(f.log[0]!);
  if (first.type !== "GameOpen") return { ok: false, steps: [{ name: "log", status: "FAIL", detail: ["the log does not start with GameOpen"] }] };
  const p = first.payload as [Hex, Hex, string, Hex[], Hex[], bigint, bigint, bigint, bigint[]];
  const [table, rh, rulesText, seats, pubkeys] = p;
  const hours = p[8].map(Number);

  // 1. chain
  const p1: string[] = [];
  let rules: RulesJson | undefined;
  try {
    rules = JSON.parse(rulesText) as RulesJson;
  } catch {
    p1.push("the rules in GameOpen are not JSON");
  }
  if (lc(table) !== lc(c.table)) p1.push(`the log is for ${table}, not ${c.table}`);
  if (rules && rulesHash(rules) !== c.rulesHash) p1.push(`the rules hash to ${rulesHash(rules)}, the table has ${c.rulesHash}`);
  if (rh !== c.rulesHash) p1.push(`GameOpen names rulesHash ${rh}, the table has ${c.rulesHash}`);
  if (seats.map(lc).join() !== c.seats.map(lc).join()) p1.push("GameOpen's seats are not the table's seats, in order");
  steps.push(step("chain", p1, `rules ${c.rulesHash.slice(0, 10)}…, ${c.seats.length} seats`));

  // 2. tape
  const p2: string[] = [];
  for (const h of hours) {
    const lines = f.tape.get(h);
    if (!lines) {
      p2.push(`tape hour ${h} is missing`);
      continue;
    }
    const anchored = c.tapeHeads.get(h);
    if (!anchored || anchored === ZERO) {
      p2.push(`tape hour ${h} is not anchored on chain`);
      continue;
    }
    const r = verifyTape(c.chainId, h, lines, undefined, anchored);
    if (!r.ok) p2.push(...r.problems.slice(0, 3).map((x) => `hour ${h}: ${x}`));
  }
  steps.push(step("tape", p2, `${hours.length} ${hours.length === 1 ? "hour" : "hours"}, each at its anchored tapeHead`));

  // 3. quotes
  steps.push(step("quotes", f.quoteProblems ?? [], `${chainlinkQuotes(hours.map((h) => f.tape.get(h) ?? [])).length} Chainlink quotes match their rounds`, f.quoteProblems ? undefined : "no RPC given: Chainlink rounds not checked"));

  // 4. keys
  const p4 = keyProblems(seats, pubkeys, c.keys);
  let orders = 0;
  f.log.forEach((x, i) => {
    const e = decodeLogEvent(x);
    if (e.type !== "OrderIn") return;
    orders++;
    const [seat, bytes, sig] = e.payload as [Hex, Hex, Hex];
    const bad = orderSigProblem(seats, pubkeys, seat, bytes, sig);
    if (bad) p4.push(`#${i}: ${bad}`);
  });
  steps.push(step("keys", p4, `${pubkeys.length} session keys on chain, ${orders} order signatures`));

  // 5. replay
  if (!rules) return { ok: false, steps };
  const pr = parseRules(rules);
  const ticks = ticksFromTape(hours.map((h) => f.tape.get(h) ?? []));
  const t: Ticks = (ts) => ticks.get(ts);
  const score = { stack: pr.stack, lambdaBps: pr.lambdaBps, minFills: pr.minFills, minExposureBps: pr.minExposureBps };
  const rp = replayLog(c.chainId, f.log, pr, t, c.posted.logHead, score, f.flaggedPairs ?? []);
  const p5 = rp.problems.filter((x) => !/signature|session key|has no seat/.test(x)); // step 4 reports those
  if (!rp.standings) p5.push("the log is not closed with GameClose");
  steps.push(step("replay", p5, `${f.log.length} events, head ${rp.head.slice(0, 10)}…`));

  // 6. result
  const p6: string[] = [];
  const P = c.posted;
  if (rp.recorder && rp.standings) {
    const er = rp.recorder.chain.eventsTree().root;
    if (er !== P.eventsRoot) p6.push(`eventsRoot: posted ${P.eventsRoot}, replay ${er}`);
    const sr = standingsTree(c.chainId, c.table, rp.standings).root;
    if (sr !== P.standingsRoot) p6.push(`standingsRoot: posted ${P.standingsRoot}, replay ${sr}`);
    if (c.podiumSize > 0) {
      const want = rp.standings.slice(0, c.podiumSize).map((s) => lc(s.seat));
      if (want.join() !== P.podium.map(lc).join()) p6.push(`podium: posted ${P.podium.join(",")}, replay ${want.join(",")}`);
    } else if (f.payouts) {
      const total = f.payouts.reduce((a, r) => a + r.amount, 0n);
      const root = f.payouts.length ? payoutTree(c.chainId, c.table, f.payouts).root : ZERO;
      if (root !== P.payoutRoot) p6.push(`payoutRoot: posted ${P.payoutRoot}, rows ${root}`);
      if (total !== P.totalPayout) p6.push(`totalPayout: posted ${P.totalPayout}, rows ${total}`);
      const ranked = new Set(rp.standings.map((s) => lc(s.seat)));
      for (const r of f.payouts) if (!ranked.has(lc(r.account))) p6.push(`payout to ${r.account}, who has no seat`);
    } else p6.push("a Freeroll needs its payout rows (--payouts) to check payoutRoot");
    if (f.engineBuild && !p6.length) {
      const d = resultDigest(c.chainId, c.registry, c.table, c.rulesHash, {
        round: P.round, logHead: P.logHead, eventsRoot: P.eventsRoot, standingsRoot: P.standingsRoot, podium: P.podium,
        payoutRoot: P.payoutRoot, totalPayout: P.totalPayout, engineBuild: f.engineBuild, logURI: P.logURI,
      });
      if (d !== P.digest) p6.push(`the digest with engine build ${f.engineBuild} is ${d}, the table holds ${P.digest}`);
    }
  } else p6.push("no standings to compare (see replay)");
  steps.push(step("result", p6, f.engineBuild ? "roots, podium and the signed digest match" : "roots and podium match (no --engine-build: the digest was not recomputed)"));

  return { ok: steps.every((s) => s.status !== "FAIL"), steps, standings: rp.standings };
}
