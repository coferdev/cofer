/**
 * GET /v1/pots/:pot/members?after=<address>&limit=<1..200>: a group account's members by address, from the indexer:
 * address, active (false once removed or fully exited), shares (18 decimals) and the block of their MemberAdded log.
 * No names, usernames or Telegram ids: the members table holds none, and none is joined in.
 * Paged in address order: `next` is the `after` for the following page (null on the last).
 */
import { getAddress, type Address } from "viem";

export const MEMBERS_CACHE_MS = 15_000;
export const MEMBERS_MAX_LIMIT = 200;
export const MEMBERS_DEFAULT_LIMIT = 50;

export interface MemberRow {
  address: string;
  active: boolean;
  shares: string;
}

export interface MembersDeps {
  /** Members after `after` (address order, case-insensitive), at most `limit`. */
  members(pot: Address, after: string | null, limit: number): Promise<MemberRow[]>;
  /** The block of each member's MemberAdded log for this pot (latest one, if added again later). */
  joinBlocks(pot: Address, members: string[]): Promise<Map<string, bigint>>;
}

export interface MembersPage {
  members: { address: Address; active: boolean; shares: string; joinBlock: bigint | null }[];
  next: Address | null;
}

/** "limit" from the query: a whole number from 1 to MEMBERS_MAX_LIMIT, else null. */
export function limitParam(s: string | undefined, def: number, max: number): number | null {
  if (s === undefined || s === "") return def;
  if (!/^\d{1,4}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= max ? n : null;
}

export async function readMembers(d: MembersDeps, pot: Address, after: string | null, limit: number): Promise<MembersPage> {
  const rows = await d.members(pot, after, limit + 1);
  const page = rows.slice(0, limit);
  const joins = await d.joinBlocks(pot, page.map((r) => r.address));
  return {
    members: page.map((r) => ({ address: getAddress(r.address), active: r.active, shares: r.shares, joinBlock: joins.get(r.address.toLowerCase()) ?? null })),
    next: rows.length > limit ? getAddress(page.at(-1)!.address) : null,
  };
}

/**
 * GET /v1/members/:address: every group account where this key is an active member, with its shares there and the
 * block it joined. From the indexer's members table (addresses and shares only) and the MemberAdded logs.
 */
export interface KeyGroupsDeps {
  /** The pots where this address is an active member, with its shares there. */
  groupsOf(member: string): Promise<{ pot: string; shares: string }[]>;
  /** The block of this member's MemberAdded log in each pot (latest one). */
  joinBlocksIn(member: string, pots: string[]): Promise<Map<string, bigint>>;
}

export async function readKeyGroups(d: KeyGroupsDeps, member: Address): Promise<{ address: Address; groups: { pot: Address; shares: string; joinBlock: bigint | null }[] }> {
  const rows = await d.groupsOf(member);
  const joins = await d.joinBlocksIn(member, rows.map((r) => r.pot));
  return {
    address: member,
    groups: rows.map((r) => ({ pot: getAddress(r.pot), shares: r.shares, joinBlock: joins.get(r.pot.toLowerCase()) ?? null })).sort((a, b) => a.pot.toLowerCase().localeCompare(b.pot.toLowerCase())),
  };
}
