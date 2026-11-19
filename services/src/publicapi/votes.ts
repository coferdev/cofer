/**
 * GET /v1/pots/:pot/votes?state=open|ready|queued|executed|expired|stale|failed&limit=<1..100>: a group's votes:
 * votes made outside the bot first (newest first), then the bot's votes, newest first. Each has its kind, its state, a plain summary made again from its own bytes with addresses only
 * (core/describePublic.ts), when it was made, its deadline, when it can run (queued), approvals so far out of the
 * approvals needed, and its transaction.
 *
 * Votes made outside the bot are included, from the group account's ProposalQueued and ProposalExecuted logs: their
 * kind, state, run time and transaction are on-chain; their full details are in that transaction.
 * The proposals table's Telegram columns (proposer, message id) and its stored summary are never read.
 */
import type { Address, Hex } from "viem";
import { describePublic, type TokenInfo } from "../core/describePublic";
import { KIND_NAMES } from "../core/txExplain";

export const VOTES_CACHE_MS = 15_000;
export const VOTES_MAX_LIMIT = 100;
export const VOTE_STATES = ["open", "ready", "queued", "executed", "expired", "stale", "failed"] as const;
export type VoteState = (typeof VOTE_STATES)[number];

/** The indexer's vote status names, as the API shows them. */
const STATE_OF: Record<string, VoteState> = { collecting: "open", ready: "ready", queued: "queued", executed: "executed", expired: "expired", stale: "stale", failed: "failed" };
const STATUS_OF: Record<VoteState, string> = { open: "collecting", ready: "ready", queued: "queued", executed: "executed", expired: "expired", stale: "stale", failed: "failed" };

export interface BotVoteRow {
  id: string; // digest
  kind: number;
  data: string;
  status: string;
  deadline: number;
  queuedEta: number | null;
  txHash: string | null;
  createdAt: Date;
}

export interface OutsideEventRow {
  name: "ProposalQueued" | "ProposalExecuted";
  digest: string;
  kind: number;
  eta: number | null;
  txHash: string;
  block: bigint;
}

export interface VotesDeps {
  /** The bot's votes for this pot (only these columns), newest first, optionally only some statuses. */
  botVotes(pot: Address, statuses: string[] | null, limit: number): Promise<BotVoteRow[]>;
  /** Every vote id the bot has for this pot. */
  botVoteIds(pot: Address): Promise<Set<string>>;
  /** Approvals not withdrawn, per vote id. */
  approvals(ids: string[]): Promise<Map<string, number>>;
  /** The pot's ProposalQueued and ProposalExecuted logs. */
  voteEvents(pot: Address): Promise<OutsideEventRow[]>;
  usdg: Address;
  token: TokenInfo;
}

export interface PublicVote {
  id: Hex;
  kind: string;
  state: VoteState;
  summary: string;
  madeBy: "bot" | "outside the bot";
  createdAt: string | null;
  deadline: number | null;
  canRunAfter: number | null;
  approvals: number | null;
  approvalsNeeded: number;
  txHash: string | null;
}

export async function readVotes(d: VotesDeps, pot: Address, state: VoteState | null, limit: number, approvalsNeeded: number): Promise<PublicVote[]> {
  const rows = await d.botVotes(pot, state ? [STATUS_OF[state]] : null, limit);
  const counts = await d.approvals(rows.map((r) => r.id));
  const known = new Set([...(await d.botVoteIds(pot))].map((x) => x.toLowerCase()));
  const out: PublicVote[] = await Promise.all(
    rows.map(async (r) => ({
      id: r.id as Hex,
      kind: KIND_NAMES[r.kind] ?? `action ${r.kind}`,
      state: STATE_OF[r.status] ?? "failed",
      summary: await describePublic(r.kind, r.data as Hex, d.usdg, d.token),
      madeBy: "bot" as const,
      createdAt: r.createdAt.toISOString(),
      deadline: r.deadline,
      canRunAfter: r.queuedEta,
      approvals: counts.get(r.id) ?? 0,
      approvalsNeeded,
      txHash: r.txHash,
    })),
  );
  // votes made outside the bot: queued or executed on-chain, with no row in the bot's table
  const outside = new Map<string, PublicVote & { block: bigint }>();
  for (const e of (await d.voteEvents(pot)).sort((a, b) => (a.block < b.block ? -1 : 1))) {
    const id = e.digest.toLowerCase();
    if (known.has(id)) continue;
    const prev = outside.get(id);
    outside.set(id, {
      id: e.digest as Hex,
      kind: KIND_NAMES[e.kind] ?? `action ${e.kind}`,
      state: e.name === "ProposalExecuted" ? "executed" : "queued",
      summary: `A vote to ${KIND_NAMES[e.kind] ?? `do action ${e.kind}`}, made outside the bot: its full details are in its transaction.`,
      madeBy: "outside the bot",
      createdAt: null,
      deadline: null,
      canRunAfter: e.eta ?? prev?.canRunAfter ?? null,
      approvals: null,
      approvalsNeeded,
      txHash: e.txHash,
      block: e.block,
    });
  }
  const extra = [...outside.values()].filter((v) => !state || v.state === state).sort((a, b) => (a.block > b.block ? -1 : 1)).map(({ block: _b, ...v }) => v);
  return [...extra, ...out].slice(0, limit);
}

export const stateParam = (s: string | undefined): VoteState | null | "bad" => (s === undefined || s === "" ? null : (VOTE_STATES as readonly string[]).includes(s) ? (s as VoteState) : "bad");
