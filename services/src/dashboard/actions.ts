/**
 * Dashboard action buttons (phase 2a). The dashboard never signs, votes or moves money: each button
 * only asks the server for the same one-time signer link the bot makes (routes.ts POST /links), and
 * the signer page does the rest. These rules say whether a button can work right now and, if not,
 * why, in plain words. The same rules run when the page is built (view.ts) and again when a link is
 * asked for, so a stale page cannot get a link the rules would refuse.
 *
 * Exit is never disabled: exiting is never gated (no pause, vote or oracle).
 */
import { DEPOSITS_CLOSED_TEXT } from "../core/depositGate";
import { BETA_DEPOSIT_CAP_USDG, roomLeft, roomText } from "../core/betaCap";
import type { ProposalStatus } from "./view";

export const ACTIONS = ["deposit", "exit", "claim", "spend", "approve"] as const;
export type DashAction = (typeof ACTIONS)[number];

export interface Availability {
  ok: boolean;
  reason: string | null; // why it is disabled; null when it works
}

const yes: Availability = { ok: true, reason: null };
const no = (reason: string): Availability => ({ ok: false, reason });

export const TEXT = {
  depositsClosedByGroup: "Deposits are closed by the group. A group vote can open them again.",
  noAllowance: "You have no allowance in this group. The group can set one with /allowance.",
  allowanceUsed: "Your allowance for this period is used up.",
  nothingSetAside: "Nothing is set aside for you in this group.",
  executed: "This proposal was already executed.",
  expired: "This proposal expired before it had enough approvals.",
  stale: "This proposal was cancelled by a group change.",
  failed: "This proposal's transaction failed.",
  queued: "The group already approved this; it is waiting for the exit window.",
  alreadySigned: "You already approved this proposal.",
} as const;

/**
 * Deposit. `stalePrice` is the deposit price-age check (core/depositGate.ts): an asset whose price
 * is older than the pot's limit (12 hours), null when all are fresh, undefined when it could not be
 * read (then the signer page and the contract check it, as the bot does). `nav` is the pot's value
 * in USDG units for the beta limit, or null when it could not be read (the signer page checks it).
 */
export function depositAvailability(a: {
  depositsOpen: boolean;
  stalePrice: { asset: string; ageSec: number } | null | undefined;
  nav: bigint | null;
  cap?: bigint | null;
}): Availability {
  if (!a.depositsOpen) return no(TEXT.depositsClosedByGroup);
  if (a.stalePrice) return no(DEPOSITS_CLOSED_TEXT);
  const cap = a.cap === undefined ? BETA_DEPOSIT_CAP_USDG : a.cap;
  if (a.nav !== null && roomLeft(a.nav, cap) === 0n) return no(roomText(a.nav, cap)!);
  return yes;
}

/** Spend from the member's own allowance. Unreadable (null) is left to the signer page and the contract. */
export function spendAvailability(a: { allowance: bigint | null; allowanceLeft: bigint | null }): Availability {
  if (a.allowance === 0n) return no(TEXT.noAllowance);
  if (a.allowanceLeft === 0n) return no(TEXT.allowanceUsed);
  return yes;
}

/** Claim a token set aside after an exit: only when something is set aside for this member. */
export function claimAvailability(owed: bigint[]): Availability {
  return owed.some((x) => x > 0n) ? yes : no(TEXT.nothingSetAside);
}

/** "Approve / review" on one proposal. */
export function approveAvailability(a: { status: ProposalStatus; deadline: number; now: number; signedByYou: boolean }): Availability {
  switch (a.status) {
    case "executed":
      return no(TEXT.executed);
    case "expired":
      return no(TEXT.expired);
    case "stale":
      return no(TEXT.stale);
    case "failed":
      return no(TEXT.failed);
    case "queued":
      return no(TEXT.queued);
  }
  if (a.deadline <= a.now) return no(TEXT.expired);
  if (a.signedByYou) return no(TEXT.alreadySigned);
  return yes;
}

/** Everything else stays in the group chat, where the bot builds and checks the proposal. */
export const GROUP_HINTS: { label: string; hint: string }[] = [
  { label: "Send a payment", hint: "Use /send in the group" },
  { label: "Buy Stock Tokens", hint: "Use /buy in the group" },
  { label: "Sell Stock Tokens", hint: "Use /sell in the group" },
  { label: "Set an allowance", hint: "Use /allowance in the group" },
  { label: "Add a member", hint: "They use /join in the group" },
  { label: "Group plan", hint: "Use /plan in the group" },
  { label: "Region", hint: "Use /region in the group" },
];

/** Per-asset amounts set aside for `member`: every ExitOwed to them minus every OwedClaimed by them. */
export function owedFromEvents(events: { name: string; args: Record<string, unknown> }[], member: string): { asset: string; amount: bigint }[] {
  const by = new Map<string, bigint>();
  const me = member.toLowerCase();
  for (const e of events) {
    const account = String(e.args.account ?? "").toLowerCase();
    const asset = String(e.args.asset ?? "").toLowerCase();
    const raw = String(e.args.amount ?? "");
    if (account !== me || !asset || !/^\d+$/.test(raw)) continue;
    const sign = e.name === "ExitOwed" ? 1n : e.name === "OwedClaimed" ? -1n : 0n;
    by.set(asset, (by.get(asset) ?? 0n) + sign * BigInt(raw));
  }
  return [...by].map(([asset, amount]) => ({ asset, amount: amount > 0n ? amount : 0n }));
}
