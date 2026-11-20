/**
 * What a result signer checks before it signs (spec §3.6, §4.8): the same path as `arena-replay verify`.
 *   1. the rules JSON hashes to the table's on-chain rulesHash;
 *   2. GameOpen's session keys hash to the seats' on-chain sessionKeyHash, every order's signature verifies,
 *      and the log replays (inputs only, over the verified tape) to exactly the posted events, ending in GameClose;
 *   3. logHead, eventsRoot and standingsRoot are the replay's;
 *   4. the podium (Friend Table) is the top of the replay's standings, or the payout rows (Freeroll) hash to
 *      payoutRoot and add up to totalPayout;
 *   5. engineBuild is this signer's own build.
 * Only then is the EIP-712 digest returned for signing. Any failure returns the reasons and no digest.
 */
import type { Hex } from "viem";
import { keyProblems } from "../engine/session";
import { parseRules, rulesHash, type RulesJson } from "../engine/rules";
import { payoutTree, standingsTree } from "../log/chain";
import { type Ticks, replayLog } from "../log/record";
import { type ArenaResult, resultDigest } from "./result";

export interface SignRequest {
  chainId: number;
  registry: Hex;
  table: Hex;
  onChainRulesHash: Hex;
  rulesJson: RulesJson;
  log: Hex[];
  ticks: Ticks;
  proposed: ArenaResult;
  /** Friend Table: the number of paid places (payoutBps.length). Freeroll: 0. */
  podiumSize: number;
  /** Freeroll: the payout rows the proposer built. */
  payouts?: { index: number; account: Hex; amount: bigint }[];
  /** Freeroll: the escrow's prize; totalPayout can never exceed it. */
  prize?: bigint;
  engineBuild: Hex;
  /** seat → sessionKeyHash, read from the table (seatOf) at the lock block. */
  onChainKeys: Map<string, Hex>;
  flaggedPairs?: [string, string][];
}

export type SignCheck = { ok: true; digest: Hex } | { ok: false; problems: string[] };

const ZERO = `0x${"0".repeat(64)}` as Hex;

export function checkResult(q: SignRequest): SignCheck {
  const problems: string[] = [];
  const rh = rulesHash(q.rulesJson);
  if (rh !== q.onChainRulesHash) problems.push(`rules hash ${rh} is not the table's ${q.onChainRulesHash}`);
  const rules = parseRules(q.rulesJson);
  const score = { stack: rules.stack, lambdaBps: rules.lambdaBps, minFills: rules.minFills, minExposureBps: rules.minExposureBps };
  const rp = replayLog(q.chainId, q.log, rules, q.ticks, q.proposed.logHead, score, q.flaggedPairs ?? []);
  problems.push(...rp.problems);
  if (rp.recorder) problems.push(...keyProblems(rp.recorder.open.seats, rp.recorder.open.pubkeys, q.onChainKeys));
  if (!rp.standings || !rp.recorder) problems.push("the log is not closed with GameClose");
  else {
    const events = rp.recorder.chain.eventsTree().root;
    if (events !== q.proposed.eventsRoot) problems.push(`eventsRoot ${q.proposed.eventsRoot} is not the replay's ${events}`);
    const st = standingsTree(q.chainId, q.table, rp.standings).root;
    if (st !== q.proposed.standingsRoot) problems.push(`standingsRoot ${q.proposed.standingsRoot} is not the replay's ${st}`);
    if (q.podiumSize > 0) {
      const want = rp.standings.slice(0, q.podiumSize).map((s) => s.seat.toLowerCase());
      const got = q.proposed.podium.map((a) => a.toLowerCase());
      if (want.join() !== got.join()) problems.push(`podium ${got.join(",")} is not the replay's ${want.join(",")}`);
    } else if (q.proposed.podium.length) problems.push("a Freeroll result has no podium");
  }
  if (q.podiumSize === 0) {
    const rows = q.payouts ?? [];
    const total = rows.reduce((a, r) => a + r.amount, 0n);
    if (total !== q.proposed.totalPayout) problems.push(`totalPayout ${q.proposed.totalPayout} is not the rows' ${total}`);
    if (q.prize !== undefined && total > q.prize) problems.push(`payouts ${total} exceed the prize ${q.prize}`);
    const root = rows.length ? payoutTree(q.chainId, q.table, rows).root : ZERO;
    if (root !== q.proposed.payoutRoot) problems.push(`payoutRoot ${q.proposed.payoutRoot} is not the rows' ${root}`);
    if (rp.standings) {
      const ranked = new Set(rp.standings.map((s) => s.seat.toLowerCase()));
      for (const r of rows) if (!ranked.has(r.account.toLowerCase())) problems.push(`payout to ${r.account}, who has no seat`);
    }
  } else if (q.proposed.payoutRoot !== ZERO || q.proposed.totalPayout !== 0n) problems.push("a Friend Table result has no payout root");
  if (q.proposed.engineBuild !== q.engineBuild) problems.push(`engineBuild ${q.proposed.engineBuild} is not this signer's ${q.engineBuild}`);
  if (problems.length) return { ok: false, problems };
  return { ok: true, digest: resultDigest(q.chainId, q.registry, q.table, q.onChainRulesHash, q.proposed) };
}
