/**
 * GET /v1/pots/:pot: one group account in one call, read live from the chain (plus the block it was created in, from
 * the indexer):
 *   members count, the vote rule (and how many approvals a vote needs now), the exit window, deposits open, the swap
 *   limits, total shares, every token it holds with its raw balance, what of it is free to exit (distributable) and
 *   the token's decimals, and the plan paid until.
 * Only chain data: a group account is shown by its address, never by its Telegram group. An address the factory did
 * not make is 404.
 */
import { getAddress, isAddress, type Address } from "viem";

export const POT_CACHE_MS = 30_000;
export const POT_CACHE_SIZE = 1000;

export interface PotsDeps {
  /** True when the factory made this address (factory.isPot). */
  isPot(a: Address): Promise<boolean>;
  /** A view function of the group account. */
  read(pot: Address, fn: string, args?: readonly unknown[]): Promise<unknown>;
  balanceOf(token: Address, holder: Address): Promise<bigint>;
  token(a: Address): Promise<{ symbol: string; decimals: number } | null>;
  /** FeeRouter.planPaidUntil(pot), unix seconds (0 = never paid). */
  planPaidUntil(pot: Address): Promise<bigint>;
  /** The block the factory created it in (indexer), or null if not indexed yet. */
  createdBlock(pot: Address): Promise<bigint | null>;
}

export interface PotSummary {
  address: Address;
  createdBlock: bigint | null;
  memberCount: number;
  voteRule: { threshold: number; thresholdBps: number; approvalsNeeded: number };
  exitWindowSeconds: number;
  depositsOpen: boolean;
  maxSlipBps: number;
  entrySpreadBps: number;
  totalShares: bigint;
  epoch: bigint;
  planPaidUntil: number | null;
  assets: { asset: Address; symbol: string | null; decimals: number | null; rawBalance: bigint; distributable: bigint }[];
}

/** A pot address from the request: checksummed, or null when it is not an address. */
export function potParam(s: string): Address | null {
  return /^0x[0-9a-fA-F]{40}$/.test(s) && isAddress(s, { strict: false }) ? getAddress(s) : null;
}

/** As the pot counts it (CoferPot.requiredVotes): a share of members rounded up when thresholdBps > 0, else the fixed count. */
export function approvalsNeeded(memberCount: number, threshold: number, thresholdBps: number): number {
  if (memberCount === 0) return 0;
  if (thresholdBps > 0) return Math.max(1, Math.ceil((memberCount * thresholdBps) / 10_000));
  return Math.min(threshold, memberCount);
}

export async function readPotSummary(d: PotsDeps, pot: Address): Promise<PotSummary> {
  const [count, threshold, bps, config, total, epoch, held, paid, created] = await Promise.all([
    d.read(pot, "memberCount"),
    d.read(pot, "threshold"),
    d.read(pot, "thresholdBps"),
    d.read(pot, "config") as Promise<readonly [number, number, number, boolean]>,
    d.read(pot, "totalShares"),
    d.read(pot, "epoch"),
    d.read(pot, "heldAssets") as Promise<readonly Address[]>,
    d.planPaidUntil(pot),
    d.createdBlock(pot),
  ]);
  const assets = await Promise.all(
    held.map(async (a) => {
      const [bal, free, t] = await Promise.all([d.balanceOf(a, pot), d.read(pot, "distributable", [a]) as Promise<bigint>, d.token(a)]);
      return { asset: getAddress(a), symbol: t?.symbol ?? null, decimals: t?.decimals ?? null, rawBalance: bal, distributable: free };
    }),
  );
  const n = Number(count);
  return {
    address: pot,
    createdBlock: created,
    memberCount: n,
    voteRule: { threshold: Number(threshold), thresholdBps: Number(bps), approvalsNeeded: approvalsNeeded(n, Number(threshold), Number(bps)) },
    exitWindowSeconds: Number(config[0]),
    depositsOpen: Boolean(config[3]),
    maxSlipBps: Number(config[1]),
    entrySpreadBps: Number(config[2]),
    totalShares: BigInt(total as bigint),
    epoch: BigInt(epoch as bigint),
    planPaidUntil: Number(paid) > 0 ? Number(paid) : null,
    assets,
  };
}

/** A small per-key cache with one shared read per key and per period (oldest key dropped first). */
export function perKeyCache<T>(read: (key: string) => Promise<T>, ttlMs: number, max: number, now: () => number = Date.now) {
  const kept = new Map<string, { at: number; value: T }>();
  const inflight = new Map<string, Promise<{ at: number; value: T }>>();
  return async (key: string) => {
    const hit = kept.get(key);
    if (hit && now() - hit.at < ttlMs) return hit;
    let p = inflight.get(key);
    if (!p) {
      p = read(key)
        .then((value) => {
          const v = { at: now(), value };
          kept.delete(key);
          kept.set(key, v);
          if (kept.size > max) kept.delete(kept.keys().next().value!);
          return v;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    return p;
  };
}
