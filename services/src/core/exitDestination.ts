/**
 * Exit to a different address (signer page). CoferPot.exit(shares, to) accepts any destination; the
 * page uses the member's own key unless the member opens "Send to a different address" and types one.
 *
 * The destination is only ever typed on the page: never read from the URL, the one-time link, a
 * query string or the dashboard. These checks are pure (no network, no DOM): the page reads the
 * on-chain parts (fee router, listed tokens, isAdapter, isPot) and passes them in.
 *
 * Note: a token that cannot be sent during the exit is set aside by the pot for the destination
 * (owed[asset][to]), not for the member's key. Anyone may call claimOwed(asset, to) later and the
 * tokens always go to `to`.
 */
import { getAddress, isAddress, type Address } from "viem";

/** Shown above the address field and again next to the checkbox. */
export const EXIT_NETWORK_WARNING =
  "This sends USDG and Stock Tokens on Robinhood Chain only. The address must be a wallet you control that supports Robinhood Chain. Do NOT use an exchange deposit address unless it clearly supports Robinhood Chain USDG: otherwise the funds are lost and cannot be recovered.";

/** The checkbox the member must tick before a different address can be used. */
export const EXIT_CONFIRM_TEXT = "I checked this address supports Robinhood Chain and is mine. Sending to a wrong address cannot be undone.";

/** Shown with a different address: where a token that cannot be sent now is kept. */
export const EXIT_SET_ASIDE_NOTE =
  "If a token cannot be sent during the exit (for example, its issuer paused it), it is set aside for that address, not for your key.";

export const EXIT_TOGGLE_TEXT = "Send to a different address";

export const NETWORK_NAME = "Robinhood Chain";

/** Plain reasons for a refused destination. */
export const DEST_TEXT = {
  empty: "Type the address, or close \"Send to a different address\" to exit to your own key.",
  invalid: "That is not a valid address. It must be 0x followed by 40 letters and numbers, copied exactly.",
  zero: "That is the zero address. Anything sent there is lost.",
  pot: "That is this group account's own contract, not a wallet.",
  otherPot: "That is a Cofer group account contract, not a wallet.",
  factory: "That is the Cofer factory contract, not a wallet.",
  feeRouter: "That is the Cofer fee contract, not a wallet.",
  adapter: "That is the Cofer swap contract, not a wallet.",
  usdg: "That is the USDG token contract. Tokens sent there are lost.",
  stockToken: "That is a Stock Token's contract address. Tokens sent there are lost.",
  unchecked: "Could not check that address right now. Try again, or close \"Send to a different address\" to exit to your own key.",
  notConfirmed: "Tick the box to confirm the address first.",
} as const;

/** Contract addresses a destination may never be. */
export interface BlockedAddresses {
  pot: Address;
  factory?: Address;
  feeRouter?: Address;
  adapters: readonly Address[];
  usdg: Address;
  stockTokens: readonly Address[];
}

const ZERO = "0x0000000000000000000000000000000000000000";
const same = (a: string | undefined, b: string) => !!a && a.toLowerCase() === b.toLowerCase();

/** A refusal reason for a typed destination, or null if it may be used. Checks the format, then each contract. */
export function destinationProblem(typed: string, b: BlockedAddresses): string | null {
  const t = typed.trim();
  if (t === "") return DEST_TEXT.empty;
  if (!/^0x[0-9a-fA-F]{40}$/.test(t) || !isAddress(t)) return DEST_TEXT.invalid; // a mixed-case address must carry a correct checksum
  if (same(t, ZERO)) return DEST_TEXT.zero;
  if (same(t, b.pot)) return DEST_TEXT.pot;
  if (same(b.factory, t)) return DEST_TEXT.factory;
  if (same(b.feeRouter, t)) return DEST_TEXT.feeRouter;
  if (b.adapters.some((a) => same(a, t))) return DEST_TEXT.adapter;
  if (same(b.usdg, t)) return DEST_TEXT.usdg;
  if (b.stockTokens.some((a) => same(a, t))) return DEST_TEXT.stockToken;
  return null;
}

/** The address in full, checksummed, in groups of four: "0x1A2b 3C4d ...". */
export function groupAddress(a: string): string {
  const c = getAddress(a);
  return `0x${c.slice(2).match(/.{4}/g)!.join(" ")}`;
}

export type ExitDestination = { ok: true; to: Address; custom: boolean } | { ok: false; reason: string };

/**
 * Where the exit goes. Closed (the default): the member's own key, whatever was typed. Open: the
 * typed address, only if it passes every check and the member ticked the confirmation box.
 */
export function chooseExitDestination(i: { own: Address; open: boolean; typed: string; confirmed: boolean; blocked: BlockedAddresses }): ExitDestination {
  if (!i.open) return { ok: true, to: getAddress(i.own), custom: false };
  const problem = destinationProblem(i.typed, i.blocked);
  if (problem) return { ok: false, reason: problem };
  if (!i.confirmed) return { ok: false, reason: DEST_TEXT.notConfirmed };
  const to = getAddress(i.typed.trim());
  return { ok: true, to, custom: to !== getAddress(i.own) };
}

