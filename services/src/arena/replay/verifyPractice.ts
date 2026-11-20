/**
 * Check a finished Practice game from public data alone: its log and the tape hours it names. No chain is read.
 *   1 rules   the rules JSON in GameOpen hashes to its rulesHash, and it is Practice
 *   2 tape    every tape hour the game used is there, its hash chain holds, and each tick is the mark rule's output
 *             (and the hour's published head matches, once the hour has closed)
 *   3 replay  the whole game re-run from the logged orders on the tape's ticks gives the same events, every order
 *             signature verifies under its seat's session key, and the final head is the one published
 */
import type { Hex } from "viem";
import { decodeLogEvent } from "../log/events";
import { replayLog } from "../log/record";
import { type RulesJson, parseRules, rulesHash } from "../engine/rules";
import { verifyTape } from "../marks/tape";
import type { Standing } from "../scoring/score";
import { ticksFromTape } from "./verifyGame";

export type Status = "PASS" | "FAIL";
export interface PracticeStep {
  name: "rules" | "tape" | "replay";
  status: Status;
  detail: string[];
}
export interface PracticeCheck {
  ok: boolean;
  steps: PracticeStep[];
  head?: Hex;
  standings?: Standing[];
}

const step = (name: PracticeStep["name"], problems: string[], pass: string): PracticeStep =>
  problems.length ? { name, status: "FAIL", detail: problems.slice(0, 20) } : { name, status: "PASS", detail: [pass] };

export function verifyPractice(chainId: number, log: Hex[], tape: Map<number, Hex[]>, heads: Map<number, Hex>, expectHead?: Hex): PracticeCheck {
  const first = log[0] ? decodeLogEvent(log[0]) : null;
  if (!first || first.type !== "GameOpen") return { ok: false, steps: [{ name: "rules", status: "FAIL", detail: ["the log does not start with GameOpen"] }] };
  const p = first.payload as [Hex, Hex, string, Hex[], Hex[], bigint, bigint, bigint, bigint[]];
  const hours = p[8].map(Number);

  const rp: string[] = [];
  let rj: RulesJson | null = null;
  try {
    rj = JSON.parse(p[2]) as RulesJson;
    if (rulesHash(rj) !== p[1]) rp.push(`the rules JSON hashes to ${rulesHash(rj)}, but GameOpen says ${p[1]}`);
    if (rj.mode !== "PRACTICE") rp.push(`mode ${rj.mode}, not PRACTICE`);
  } catch (e) {
    rp.push(`the rules JSON does not parse: ${(e as Error).message}`);
  }
  const rules = step("rules", rp, `Practice rules, hash ${p[1].slice(0, 10)}…`);

  const tp: string[] = [];
  let nTicks = 0;
  for (const h of hours) {
    const lines = tape.get(h);
    if (!lines) {
      tp.push(`tape hour ${h} is missing`);
      continue;
    }
    const c = verifyTape(chainId, h, lines, undefined, heads.get(h));
    nTicks += c.ticks;
    for (const x of c.problems) tp.push(`hour ${h}: ${x}`);
  }
  const closed = hours.filter((h) => heads.has(h)).length;
  const tapeStep = step("tape", tp, `${hours.length} hour(s), ${nTicks} ticks; ${closed} closed hour(s) match their published head`);

  const xp: string[] = [];
  let head: Hex | undefined;
  let standings: Standing[] | undefined;
  if (rj && !rp.length) {
    const r = parseRules(rj);
    const ticks = ticksFromTape(tape.values());
    const out = replayLog(chainId, log, r, (ts) => ticks.get(ts), expectHead, { stack: r.stack, lambdaBps: r.lambdaBps, minFills: r.minFills, minExposureBps: r.minExposureBps });
    xp.push(...out.problems);
    head = out.head;
    standings = out.standings;
    if (!standings) xp.push("the log is not closed (no GameClose)");
  } else xp.push("not run: the rules did not check");
  const orders = log.filter((e) => decodeLogEvent(e).type === "OrderIn").length;
  const replay = step("replay", xp, `${log.length} events, ${orders} signed orders, same head ${head?.slice(0, 10)}…${expectHead ? " as published" : ""}`);

  const steps = [rules, tapeStep, replay];
  return { ok: steps.every((s) => s.status === "PASS"), steps, head, standings };
}
