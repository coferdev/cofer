/**
 * Votes the bot did not create. Members can sign a proposal with their own keys and anyone can
 * submit it to CoferPot.execute(). Such a vote has no row in `proposals`, so the notifier has no
 * card to post. Without this, a non-unanimous vote would sit in its exit window with nobody in
 * the group told about it. The indexer calls onVoteEvent for every ProposalQueued and
 * ProposalExecuted it records; votes the bot knows are left to the notifier as before.
 */
import type { Address, Hex } from "viem";
import { Kind } from "../core/proposal";

export type VoteEvent =
  | { name: "ProposalQueued"; digest: Hex; kind: number; eta: bigint }
  | { name: "ProposalExecuted"; digest: Hex; kind: number };

export interface UnknownVoteDeps {
  /** The pot's group chat, or null if the bot has no group for it. */
  chatOf(pot: Address): Promise<number | null>;
  sendGroup(chatId: number, text: string): Promise<void>;
  /** The ops alert path (log + ops chat). */
  sendOps(text: string): Promise<void>;
}

const KIND_TEXT: Record<number, string> = {
  [Kind.TRANSFER]: "send funds",
  [Kind.SWAP]: "swap",
  [Kind.ADD_MEMBER]: "add a member",
  [Kind.REMOVE_MEMBER]: "remove a member",
  [Kind.SET_ALLOWANCE]: "set an allowance",
  [Kind.SET_THRESHOLD]: "change how many approvals votes need",
  [Kind.SET_CONFIG]: "change the group settings",
  [Kind.PAY_PLAN]: "prepay the group plan",
};

export function kindText(kind: number): string {
  return KIND_TEXT[kind] ?? `vote type ${kind}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "14:05 UTC on 2 Nov 2026" */
export function utcText(unixSeconds: bigint | number): string {
  const d = new Date(Number(unixSeconds) * 1000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm} UTC on ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** What the group reads. Built only from the on-chain event, never from free text. */
export function groupText(ev: VoteEvent): string {
  if (ev.name === "ProposalQueued") {
    return `A vote that was not made through this bot was queued: ${kindText(ev.kind)}. It can run after ${utcText(ev.eta)}. If you disagree, use /exit before then to take your exact share.`;
  }
  return `A vote that was not made through this bot just executed: ${kindText(ev.kind)}. Check /pot.`;
}

/** What the ops chat reads. */
export function opsText(pot: Address, ev: VoteEvent): string {
  const what = ev.name === "ProposalQueued" ? `queued (can run after ${utcText(ev.eta)})` : "executed";
  return `vote not made through the bot ${what} in pot ${pot}: ${kindText(ev.kind)}, vote ${ev.digest}`;
}

/**
 * Alerts the group and the ops chat about a vote the bot did not create.
 * @param a.isNew  false when this log was already recorded (a re-run): nothing is sent twice.
 * @param a.known  true when the bot has a `proposals` row for this digest: the notifier handles it.
 */
export async function onVoteEvent(
  deps: UnknownVoteDeps,
  a: { pot: Address; event: VoteEvent; isNew: boolean; known: boolean },
): Promise<"alerted" | "skipped"> {
  if (!a.isNew || a.known) return "skipped";
  const chat = await deps.chatOf(a.pot);
  if (chat !== null) await deps.sendGroup(chat, groupText(a.event));
  await deps.sendOps(opsText(a.pot, a.event));
  return "alerted";
}
