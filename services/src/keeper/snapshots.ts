/**
 * Daily holdings snapshots (keeper, every 15 minutes; one snapshot per day): each group account's raw balance of every
 * token it holds, at the block nearest 00:00 UTC. Balances only: no price, no value, no total.
 *
 * Reading balances at a past block needs an archive RPC (RHC_RPC_URL is one). If the RPC cannot answer for that block,
 * the snapshot is taken at the newest block instead, and the row says which block and time it was really taken at,
 * so nothing is passed off as midnight that was not. Past days can be filled the same way (backfill) on an archive RPC.
 */
import type { Address } from "viem";

export interface SnapshotChain {
  head(): Promise<bigint>;
  blockTime(n: bigint): Promise<number>; // unix seconds
  /** The group account's held tokens at a block. Throws if the RPC cannot answer for that block. */
  heldAt(pot: Address, block: bigint): Promise<readonly Address[]>;
  balanceAt(token: Address, holder: Address, block: bigint): Promise<bigint>;
}

export interface SnapshotRow {
  pot: Address;
  asset: Address;
  day: string; // YYYY-MM-DD (UTC)
  block: bigint;
  blockTime: number;
  rawBalance: bigint;
}

export interface SnapshotDeps extends SnapshotChain {
  pots(): Promise<Address[]>;
  /** Whether this pot already has a snapshot for this day. */
  has(pot: Address, day: string): Promise<boolean>;
  save(rows: SnapshotRow[]): Promise<void>;
  now(): number; // unix seconds
}

export const dayOf = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
export const midnightOf = (day: string) => Date.parse(`${day}T00:00:00Z`) / 1000;

/** The first block at or after time `t` (binary search on block times). */
export async function blockAtOrAfter(c: Pick<SnapshotChain, "head" | "blockTime">, t: number): Promise<bigint> {
  let lo = 0n;
  let hi = await c.head();
  if ((await c.blockTime(hi)) < t) return hi;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if ((await c.blockTime(mid)) < t) lo = mid + 1n;
    else hi = mid;
  }
  return lo;
}

/** One pot's snapshot for a day: at the block nearest that midnight, or at the newest block if that one cannot be read. */
export async function snapshotPot(c: SnapshotChain, pot: Address, day: string, at: bigint): Promise<SnapshotRow[]> {
  let block = at;
  let held: readonly Address[];
  try {
    held = await c.heldAt(pot, block);
  } catch {
    block = await c.head();
    held = await c.heldAt(pot, block);
  }
  const blockTime = await c.blockTime(block);
  const rows: SnapshotRow[] = [];
  for (const asset of held) rows.push({ pot, asset, day, block, blockTime, rawBalance: await c.balanceAt(asset, pot, block) });
  return rows;
}

/** Today's snapshot for every pot that has none yet (idempotent: running it again the same day adds nothing). */
export async function takeSnapshots(d: SnapshotDeps, day = dayOf(d.now())): Promise<{ day: string; pots: number; skipped: number }> {
  const pots = await d.pots();
  let block: bigint | null = null;
  let done = 0;
  let skipped = 0;
  for (const pot of pots) {
    if (await d.has(pot, day)) {
      skipped++;
      continue;
    }
    block ??= await blockAtOrAfter(d, midnightOf(day));
    await d.save(await snapshotPot(d, pot, day, block));
    done++;
  }
  return { day, pots: done, skipped };
}
