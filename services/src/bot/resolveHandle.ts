/**
 * Turning "@bob_smith" in /send or /allowance into an address (audit v2 M-1). The lookup used to
 * pattern-match usernames (ILIKE), where "_" matches any character, so a look-alike such as
 * "bobxsmith" could be chosen and shown to voters as "@bob_smith". Now:
 *  - the handle must be a valid Telegram username (letters, digits, "_"; 5 to 32), so no pattern
 *    characters ever reach the database
 *  - only active members of this group's pot are searched, with an exact (case-insensitive) match
 *  - more than one match is refused (usernames are refreshed only on /start, so a stale one can repeat)
 *  - the label shown to voters is the username stored for that key, not what was typed
 */
import { getAddress, type Address } from "viem";

/** Telegram usernames: 5 to 32 letters, digits and underscores. */
export const TELEGRAM_USERNAME = /^[A-Za-z0-9_]{5,32}$/;

export type ParsedWho = { kind: "address"; address: Address } | { kind: "handle"; handle: string } | { kind: "invalid" };

/** "0x…" (an address), "@name" or "name" (a username), or neither. */
export function parseWho(who: string): ParsedWho {
  const w = who.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(w)) return { kind: "address", address: getAddress(w) };
  const handle = w.replace(/^@/, "");
  return TELEGRAM_USERNAME.test(handle) ? { kind: "handle", handle: handle.toLowerCase() } : { kind: "invalid" };
}

export const INVALID_HANDLE_TEXT = "That isn't a Telegram username. Use @username or a 0x address.";
export const notMemberText = (handle: string) =>
  `@${handle} isn't a member of this group account with a key set up. To send to someone outside the group, use their 0x address.`;
export const ambiguousText = (handle: string) => `More than one member is listed as @${handle}. Use their 0x address instead.`;

export interface MemberRow {
  username: string | null;
  address: string | null;
}

/**
 * Picks the one member whose stored username is exactly `handle` (case-insensitive). `rows` are this
 * pot's active members with a key; the exact comparison is repeated here so a looser query can never
 * widen the match.
 */
export function pickMember(rows: MemberRow[], handle: string): { ok: true; address: Address; label: string } | { ok: false; text: string } {
  const h = handle.toLowerCase();
  const hits = new Map<string, MemberRow>();
  for (const r of rows) if (r.address && r.username && r.username.toLowerCase() === h) hits.set(r.address.toLowerCase(), r);
  if (hits.size === 0) return { ok: false, text: notMemberText(handle) };
  if (hits.size > 1) return { ok: false, text: ambiguousText(handle) };
  const r = [...hits.values()][0]!;
  return { ok: true, address: getAddress(r.address!), label: `@${r.username}` };
}
