/**
 * Votes the bot did not create. Members can sign a proposal with their own keys and anyone can
 * submit it to CoferPot.execute(). Such a vote has no row in `proposals`, so the notifier has no
 * card to post. Without this, a non-unanimous vote would sit in its exit window with nobody in
 * the group told about it. The indexer calls onVoteEvent for every ProposalQueued and
 * ProposalExecuted it records; votes the bot knows are left to the notifier as before.
 */
import type { Address, Hex } from "viem";
import { Kind } from "../core/proposal";
import { shortHex, type AlertMessage } from "../core/alertFormat";
import { utcText, waitText } from "../core/waitText";

export type VoteEvent =
  | { name: "ProposalQueued"; digest: Hex; kind: number; eta: bigint }
  | { name: "ProposalExecuted"; digest: Hex; kind: number };

export interface UnknownVoteDeps {
  /** The pot's group chat, or null if the bot has no group for it. */
  chatOf(pot: Address): Promise<number | null>;
  sendGroup(chatId: number, text: string): Promise<void>;
  /** The staff alert path (log + staff chat). */
  sendOps(m: AlertMessage): Promise<void>;
  /** The pot's exit window in seconds (guardDelay, read from the pot), or null if the read failed. */
  exitWindowOf(pot: Address): Promise<number | null>;
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

export { utcText };

/**
 * What the group reads. Built only from the on-chain event and the pot's exit window, never from free text.
 * @param exitWindowSec the pot's guardDelay (null if it could not be read: the time is still given).
 */
export function groupText(ev: VoteEvent, exitWindowSec: number | null = null): string {
  if (ev.name === "ProposalQueued") {
    return `A vote that was not made through this bot was queued: ${kindText(ev.kind)}. ${waitText(exitWindowSec, ev.eta)}. If you disagree, use /exit before then to take your exact share.`;
  }
  return `A vote that was not made through this bot just executed: ${kindText(ev.kind)}. Check /pot.`;
}

/** What the staff chat reads (vote-unknown). */
export function opsText(pot: Address, ev: VoteEvent): AlertMessage {
  const what = ev.name === "ProposalQueued" ? `was queued and can run after ${utcText(ev.eta)}` : "executed";
  return {
    name: "vote-unknown",
    what: `A vote not made through the bot ${what} in pot ${shortHex(pot)}: ${kindText(ev.kind)} (vote ${shortHex(ev.digest)}). The group was told.`,
    who: "Dev checks. If nobody in that group made this vote, tell the owner and the dev at once.",
  };
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
  if (chat !== null) {
    const window = a.event.name === "ProposalQueued" ? await deps.exitWindowOf(a.pot).catch(() => null) : null;
    await deps.sendGroup(chat, groupText(a.event, window));
  }
  await deps.sendOps(opsText(a.pot, a.event));
  return "alerted";
}
