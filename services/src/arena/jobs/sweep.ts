/**
 * The timed table jobs (spec §5.3) as one sweep, every few seconds: for each live table, read its state from chain,
 * take the jobs its plan says are due (plan.ts planTable, at <= the chain's own clock), and ask plan.ts decide what
 * each does now. A call is relayed only if it is one of the permissionless escrow calls, and the relayer first tries
 * it against the chain, so a call that would revert is never sent. Restart-safe: nothing is kept between sweeps but
 * the calls in flight; the chain is read fresh every time.
 */
import type { Address } from "viem";
import { type Action, type JobName, type TableView, decide, planTable } from "./plan";

export type RelayCall = "lock" | "cancel" | "finalize" | "refundAll";

export interface SweepDeps {
  liveTables(): Promise<Address[]>;
  view(table: Address): Promise<TableView>;
  chainNow(): Promise<number>; // s, the latest block's timestamp (what the escrow's checks use)
  relay(table: Address, call: RelayCall): Promise<RelayOutcome>;
  /** The engine closes the game (logs, standings, signatures); null while no engine runs on this chain. */
  closeGame?: (table: Address) => Promise<void>;
  nudge?: (table: Address) => Promise<void>;
  log(line: string): void;
}

export type RelayOutcome = { sent: true; tx: string } | { sent: false; why: string };

export interface SweepItem {
  table: Address;
  job: JobName;
  action: Action;
  outcome?: RelayOutcome | "engine" | "no-engine" | "nudged";
}

const RELAYED = new Set<string>(["lock", "cancel", "finalize", "refundAll"]);

export async function sweepOnce(d: SweepDeps): Promise<SweepItem[]> {
  const now = await d.chainNow();
  const out: SweepItem[] = [];
  for (const table of await d.liveTables()) {
    let v: TableView;
    try {
      v = await d.view(table);
    } catch (e) {
      d.log(`${table}: could not read state (${(e as Error).message.split("\n")[0]})`);
      continue;
    }
    const due = planTable(v).filter((j) => j.at <= now);
    const done = new Set<string>();
    for (const j of due) {
      const action = decide(j.name, v, now);
      const item: SweepItem = { table, job: j.name, action };
      if (action.call && RELAYED.has(action.call)) {
        if (done.has(action.call)) continue; // e.g. a deadline and a close due together: one call per table per sweep
        done.add(action.call);
        item.outcome = await d.relay(table, action.call as RelayCall);
        d.log(`${table}: ${j.name} -> ${action.call}: ${item.outcome.sent ? `sent ${item.outcome.tx}` : item.outcome.why}`);
      } else if (action.call === "close-game") {
        if (d.closeGame) {
          await d.closeGame(table);
          item.outcome = "engine";
        } else item.outcome = "no-engine";
      } else if (action.call === "nudge") {
        if (d.nudge) {
          await d.nudge(table);
          item.outcome = "nudged";
        }
      }
      out.push(item);
    }
  }
  return out;
}
