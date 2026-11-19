/**
 * GET /v1/pots/:pot/timeline?after=<block>-<logIndex>&limit=<1..200>: everything a group account did, in block
 * order, from the indexer's copy of its logs: deposits, exits, allowance spends, claims, votes queued and run, sends,
 * swaps, members added or removed, settings and plan payments. Each with its block, transaction and the same plain
 * words as the transaction explainer. Events the explainer does not describe are left out, never guessed at.
 * Paging is by (block, log index), so a page never changes when newer events arrive: `next` is the `after` for the
 * following page, or null when there is nothing newer yet.
 */
import type { Address } from "viem";
import { describeEvent, type ExplainDeps, type TxKind } from "../core/txExplain";

export const TIMELINE_CACHE_MS = 15_000;
export const TIMELINE_MAX_LIMIT = 200;

export interface EventRow {
  block: bigint;
  logIndex: number;
  txHash: string;
  name: string;
  args: Record<string, unknown>;
}

export interface TimelineDeps {
  /** The pot's logs after (block, logIndex), oldest first, at most `limit`. */
  events(pot: Address, after: { block: bigint; logIndex: number } | null, limit: number): Promise<EventRow[]>;
  explain: Pick<ExplainDeps, "token" | "usdg">;
}

export interface TimelinePage {
  events: { block: bigint; logIndex: number; txHash: string; event: string; kind: TxKind; text: string; args: Record<string, unknown> }[];
  next: string | null;
}

/** "153947820-4" -> { block, logIndex }; null for empty; "bad" when malformed. */
export function afterParam(s: string | undefined): { block: bigint; logIndex: number } | null | "bad" {
  if (s === undefined || s === "") return null;
  const m = /^(\d{1,20})-(\d{1,6})$/.exec(s);
  return m ? { block: BigInt(m[1]!), logIndex: Number(m[2]) } : "bad";
}

export async function readTimeline(d: TimelineDeps, pot: Address, after: { block: bigint; logIndex: number } | null, limit: number): Promise<TimelinePage> {
  const rows = await d.events(pot, after, limit);
  const events: TimelinePage["events"] = [];
  for (const r of rows) {
    const desc = await describeEvent("group account", r.name, r.args, pot, d.explain);
    if (desc) events.push({ block: r.block, logIndex: r.logIndex, txHash: r.txHash, event: r.name, kind: desc.kind, text: desc.text, args: r.args });
  }
  const last = rows.at(-1);
  return { events, next: rows.length === limit && last ? `${last.block}-${last.logIndex}` : null };
}
