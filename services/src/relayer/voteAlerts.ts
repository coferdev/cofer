/**
 * Alerts for passed votes that fail to execute (ops chat only; members already see the vote card).
 *  - opened by the relayer: on a permanent revert that marks the vote failed, or when a vote is
 *    still failing after its last retry
 *  - cleared by the keeper's ops job once the vote executes or ends
 * "Settings changed" (stale) and "deadline passed" (expired) are normal outcomes, never alerted.
 */
import { errorKind, revertName } from "../core/errors";

export const voteAlertKey = (proposalId: string) => `vote-failed:${proposalId.toLowerCase()}`;

/** The relayer's own error for a transaction that was mined but reverted. */
export class RevertedOnChain extends Error {
  constructor(hash: string) {
    super(`reverted in ${hash}`);
    this.name = "RevertedOnChain";
  }
}

/** A short, fixed reason for the ops chat: the contract's error name, never raw error text. */
export function failureReason(e: unknown): string {
  const name = revertName(e);
  if (name) return name;
  if (e instanceof RevertedOnChain) return "the transaction reverted on-chain";
  return errorKind(e) === "rpc" ? "chain error (could not reach the chain or the relayer's transaction failed to send)" : "the contract refused it";
}

const short = (hex: string) => `${hex.slice(0, 10)}…`;

export function voteFailedText(p: { id: string; pot: string; summary: string }, reason: string, how: { permanent: true } | { tries: number }): string {
  const what = `Vote ${short(p.id)} in pot ${short(p.pot)} (${p.summary})`;
  return "permanent" in how
    ? `${what} failed to execute: ${reason}. It is marked failed and will not run.`
    : `${what} is still failing to execute after ${how.tries} tries: ${reason}.`;
}

/** Why an open vote alert can clear now, or null to keep it open. */
export function voteAlertClears(p: { status: string; deadline: number } | undefined, nowSec: number): string | null {
  if (!p) return "the vote is gone";
  switch (p.status) {
    case "executed":
      return "it executed";
    case "expired":
      return "it expired";
    case "stale":
      return "group settings changed, so it can no longer run";
    case "failed":
      return p.deadline < nowSec ? "its deadline has passed" : null;
    default:
      return null; // ready / queued: still meant to run
  }
}
