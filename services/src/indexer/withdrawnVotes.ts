/**
 * Queued votes that lose an approval. Once a vote has started its exit window on the pot, the bot
 * treats any lost approval (a member withdraws their vote, or an approving member leaves) as the vote
 * being withdrawn for good: it is marked stale, so the bot never collects approvals for it again and
 * the relayer never sends it, and the group is told. If the pot still runs it later (anyone can call
 * the pot directly), the group and the staff chat are alerted at once.
 */
import { sql } from "drizzle-orm";
import type { Address, Hex } from "viem";
import { shortHex, type AlertMessage } from "../core/alertFormat";
import { kindText } from "./unknownVotes";

/** A proposal row, as far as this needs it. `queuedEta` is set once the pot queued it. */
export interface QueuedRow {
  id: Hex;
  pot: Address;
  kind: number;
  status: string;
  queuedEta: number | null;
}

export interface WithdrawnVoteDeps {
  /** Queued proposals of this pot that `member` approved (signature not revoked), or just `digest` if given. */
  queuedApprovedBy(pot: Address, member: Address, digest?: Hex): Promise<QueuedRow[]>;
  markWithdrawn(id: Hex): Promise<void>;
  chatOf(pot: Address): Promise<number | null>;
  sendGroup(chatId: number, text: string): Promise<void>;
  sendOps(m: AlertMessage): Promise<void>;
}

/** Was this row queued on the pot (its exit window started) and not finished? */
export const wasQueued = (r: Pick<QueuedRow, "status" | "queuedEta">) => r.queuedEta !== null && (r.status === "queued" || r.status === "ready");

export function withdrawnText(kind: number): string {
  return `A vote that was waiting for its exit window lost an approval: ${kindText(kind)}. The bot now treats it as withdrawn for good: it will not collect approvals for it or send it again. If it is still wanted, propose it again.`;
}

export function revivedTexts(pot: Address, digest: Hex, kind: number): { group: string; ops: AlertMessage } {
  return {
    group: `A vote that had been withdrawn just ran on the contract: ${kindText(kind)}. Check /pot. If nobody in this group meant to run it, tell the Cofer team now.`,
    ops: {
      name: "vote-revived",
      what: `A withdrawn vote ran in pot ${shortHex(pot)}: ${kindText(kind)} (vote ${shortHex(digest)}). It had lost an approval after its exit window started. The group was told.`,
      who: "Dev checks the transaction now and tells the owner.",
    },
  };
}

/**
 * VoteRevoked (with `digest`) or MemberRemoved (without): every queued vote that member had approved
 * is withdrawn for good. Returns the ids marked. Runs only for a log seen the first time.
 */
export async function onApprovalLost(deps: WithdrawnVoteDeps, a: { pot: Address; member: Address; digest?: Hex; isNew: boolean }): Promise<Hex[]> {
  if (!a.isNew) return [];
  const rows = (await deps.queuedApprovedBy(a.pot, a.member, a.digest)).filter(wasQueued);
  if (rows.length === 0) return [];
  const chat = await deps.chatOf(a.pot);
  for (const r of rows) {
    await deps.markWithdrawn(r.id);
    if (chat !== null) await deps.sendGroup(chat, withdrawnText(r.kind));
  }
  return rows.map((r) => r.id);
}

/** ProposalExecuted for a row the bot had marked withdrawn (stale after being queued): alert at once. */
export async function onExecutedAfterWithdrawal(deps: Pick<WithdrawnVoteDeps, "chatOf" | "sendGroup" | "sendOps">, a: { before: QueuedRow | null; isNew: boolean }): Promise<boolean> {
  const r = a.before;
  if (!a.isNew || !r || r.status !== "stale" || r.queuedEta === null) return false;
  const t = revivedTexts(r.pot, r.id, r.kind);
  const chat = await deps.chatOf(r.pot);
  if (chat !== null) await deps.sendGroup(chat, t.group);
  await deps.sendOps(t.ops);
  return true;
}

/**
 * The rows `queuedApprovedBy` returns: queued (exit window started, not finished) proposals of `pot` that
 * `member` signed. With `digest` (a withdrawal): that proposal, if the member had signed it. Without (the
 * member left): every such proposal where the member's approval still counted.
 */
export function queuedApprovedQuery(pot: Address, member: Address, digest?: Hex) {
  return sql`select p.id, p.pot, p.kind, p.status, p.queued_eta as "queuedEta" from proposals p
    join signatures s on s.proposal_id = p.id
    where p.pot = ${pot} and s.signer = ${member} and p.status in ('queued', 'ready') and p.queued_eta is not null
    and ${digest === undefined ? sql`s.revoked = false` : sql`p.id = ${digest}`}`;
}
