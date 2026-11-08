/**
 * Contract refusals a member can hit on the signer page (deposit, exit, claim, spend, card load),
 * written as plain sentences. This is the one place they are mapped. A refusal is recognised only by
 * its 4-byte error selector, taken from the pot's (and factory's) generated ABI, never from free
 * text, and only the fixed sentence below is ever shown: no hex, URL or key reaches the member.
 *
 * Anything not recognised here falls back to retryText.ts (the generic "Something went wrong").
 */
import { BaseError, ContractFunctionRevertedError, formatUnits, toFunctionSelector, type Hex } from "viem";
import { coferFactoryAbi, coferPotAbi } from "../chain/abi";
import { DEPOSITS_CLOSED_TEXT } from "./depositGate";
import { allowanceLeft, type AllowanceState } from "./shares";

/** Error name (as in the pot ABI) -> what the member reads. */
export const REFUSAL_TEXT = {
  AllowanceExceeded: "That is more than your allowance has left. Nothing was sent.",
  NoAllowance: "You have no allowance in this group. The group can give you one with a vote. Nothing was sent.",
  InsufficientBalance: "The group account does not hold enough for this right now. Nothing was sent.",
  NotMember: "Your key is not a member of this group. Nothing was sent.",
  ZeroAmount: "Enter an amount above 0. Nothing was sent.",
  BadParam: "That address or amount is not valid. Nothing was sent.",
  DepositsClosed: "Deposits are closed for this group right now. Exiting is always open. Nothing was sent.",
  DepositPriceTooOld: DEPOSITS_CLOSED_TEXT,
  StalePrice: "A price this group needs is not available right now. Try again later. Nothing was sent.",
  BadPrice: "A price this group needs is not available right now. Try again later. Nothing was sent.",
  InsufficientShares: "You have fewer shares than this exit asks for. Check /me in Telegram. Nothing was sent.",
  NothingOwed: "Nothing is set aside for you in this group.",
  TransferFailed: "A token could not be sent right now (its issuer may have paused it). Nothing was sent. Try again later.",
  TransferFromFailed: "The USDG could not be taken from your key. Check that your key holds enough USDG. Nothing was sent.",
} as const;

export type RefusalName = keyof typeof REFUSAL_TEXT;

/** Pot errors first; the factory adds only the price errors a deposit can bubble up. */
const SOURCES = [...coferPotAbi, ...coferFactoryAbi.filter((x) => x.type === "error" && (x.name === "StalePrice" || x.name === "BadPrice"))];

/** selector (lowercase 0x + 8 hex) -> error name, for every refusal above, built from the ABI. */
export const REFUSAL_SELECTORS: ReadonlyMap<string, RefusalName> = (() => {
  const m = new Map<string, RefusalName>();
  for (const x of SOURCES) {
    if (x.type !== "error" || !(x.name in REFUSAL_TEXT)) continue;
    const e = x as unknown as { name: string; inputs: readonly { type: string }[] };
    const sel = toFunctionSelector(`${e.name}(${e.inputs.map((i) => i.type).join(",")})`).toLowerCase();
    if (!m.has(sel)) m.set(sel, e.name as RefusalName);
  }
  return m;
})();

/**
 * Revert data is a selector alone (10 chars) or a selector plus 32-byte words. That shape rules out
 * addresses (42 chars) and hashes (66 chars), so a random address can never be read as a refusal.
 */
const HEX = /0x[0-9a-fA-F]{8}(?:[0-9a-fA-F]{64})*(?![0-9a-fA-F])/g;

function selectorsIn(text: string): string[] {
  return [...text.matchAll(HEX)].map((m) => m[0].slice(0, 10).toLowerCase());
}

/** Strings an error (and its causes) carries: message, details and revert data. */
function textsOf(e: unknown): string[] {
  const out: string[] = [];
  for (let x = e as Record<string, unknown> | undefined, i = 0; x && typeof x === "object" && i < 10; x = x.cause as typeof x, i++) {
    for (const k of ["message", "shortMessage", "details", "data", "reason", "raw", "signature"]) {
      const v = x[k];
      if (typeof v === "string") out.push(v);
      else if (v && typeof v === "object" && typeof (v as { data?: unknown }).data === "string") out.push((v as { data: string }).data);
    }
    if (Array.isArray(x.metaMessages)) for (const m of x.metaMessages) if (typeof m === "string") out.push(m);
  }
  return out;
}

/** The known refusal in an error from viem, ZeroDev, the bundler or a wallet; null if there is none. */
export function refusalName(e: unknown): RefusalName | null {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    const name = r instanceof ContractFunctionRevertedError ? r.data?.errorName : undefined;
    if (name && name in REFUSAL_TEXT) return name as RefusalName;
  }
  for (const t of textsOf(e)) {
    for (const sel of selectorsIn(t)) {
      const name = REFUSAL_SELECTORS.get(sel);
      if (name) return name;
    }
  }
  return null;
}

/** The sentence for a known refusal, or null (the caller then shows the generic text). */
export function refusalText(e: unknown): string | null {
  const n = refusalName(e);
  return n ? REFUSAL_TEXT[n] : null;
}

/** Decodes a bare selector (for tests and the runbook table). */
export function refusalForSelector(selector: Hex): RefusalName | null {
  return REFUSAL_SELECTORS.get(selector.toLowerCase()) ?? null;
}

/** "this day" / "this week" / "this period", for the allowance's own period. */
export function periodWord(periodSec: number): string {
  if (periodSec === 86400) return "this day";
  if (periodSec === 7 * 86400) return "this week";
  return "this period";
}

/**
 * Checked on the signer page before the passkey is asked for: a spend above what is left of the
 * member's allowance (same math as the pot: shares.ts allowanceLeft over memberInfo) is refused here.
 * Returns the sentence to show, or null when the amount fits.
 */
export function spendAllowanceRefusal(amount: bigint, s: AllowanceState, nowSec: number): string | null {
  if (s.period === 0 || s.allowance === 0n) return REFUSAL_TEXT.NoAllowance;
  const left = allowanceLeft(s, nowSec);
  if (amount <= left) return null;
  return `That is more than your allowance. You have ${formatUnits(left, 6)} USDG left ${periodWord(s.period)}.`;
}
