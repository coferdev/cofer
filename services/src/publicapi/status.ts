/**
 * GET /v1/status: is Cofer's backend keeping up with the chain? All of it is public on-chain data or derived from it:
 *   - chainId and the latest block the server's RPC sees;
 *   - the indexer: the last block it saved, how far behind the chain it is (blocks and seconds, counted against the
 *     block it should have reached, head minus confirmations), and live / behind / not started;
 *   - the relayer (the address that pays gas to run passed votes): whether it holds enough gas to do so, and about
 *     how many days that lasts at its recent average spend. Never the balance itself;
 *   - every listed price feed: its age, its limit (the factory's maxStaleness), and ok / near limit / past limit / bad.
 * Read once per STATUS_CACHE_MS for everyone (publicapi/format.ts cached), never per request.
 */
import { INDEXER_MAX_LAG_SEC } from "../core/indexerLag";
import { FEED_WARN_BEFORE_LIMIT_SEC } from "../core/feedHealth";

export const STATUS_CACHE_MS = 15_000;

export interface FeedReading {
  symbol: string;
  asset: string;
  answer: bigint;
  updatedAt: number; // unix seconds
  maxStaleness: number; // seconds
}

export interface StatusDeps {
  chainId: number;
  confirmations: number;
  head(): Promise<bigint>;
  blockTime(n: bigint): Promise<number>; // unix seconds
  cursor(): Promise<bigint | null>; // the last block the indexer saved
  feeds(): Promise<FeedReading[]>;
  relayerHasGas(): Promise<boolean>;
  /** Days of gas left at the relayer's recent average spend (null: no recent spend). */
  relayerDaysLeft(): Promise<number | null>;
  now(): number; // unix seconds
}

export type IndexerState = "live" | "behind" | "not started";
export type FeedState = "ok" | "near limit" | "past limit" | "bad";

export interface Status {
  chainId: number;
  headBlock: bigint;
  indexer: { state: IndexerState; lastBlock: bigint | null; targetBlock: bigint; lagBlocks: bigint | null; lagSeconds: number | null; maxLagSeconds: number };
  relayer: { hasGas: boolean | null; daysLeft: number | null };
  feeds: { symbol: string; asset: string; state: FeedState; ageSeconds: number; limitSeconds: number }[];
}

export function feedState(f: FeedReading, now: number, warnBeforeSec = FEED_WARN_BEFORE_LIMIT_SEC): FeedState {
  if (f.answer <= 0n || f.updatedAt > now) return "bad";
  const age = now - f.updatedAt;
  if (age > f.maxStaleness) return "past limit";
  if (age >= f.maxStaleness - warnBeforeSec) return "near limit";
  return "ok";
}

export async function readStatus(d: StatusDeps): Promise<Status> {
  const [head, cursor, feeds, hasGas, daysLeft] = await Promise.all([d.head(), d.cursor(), d.feeds(), d.relayerHasGas().catch(() => null), d.relayerDaysLeft().catch(() => null)]);
  const target = head - BigInt(d.confirmations);
  let lagSeconds: number | null = null;
  let state: IndexerState = "not started";
  if (cursor !== null) {
    if (cursor >= target) lagSeconds = 0;
    else {
      const [tt, ct] = await Promise.all([d.blockTime(target), d.blockTime(cursor)]);
      lagSeconds = Math.max(0, tt - ct);
    }
    state = lagSeconds <= INDEXER_MAX_LAG_SEC ? "live" : "behind";
  }
  const now = d.now();
  return {
    chainId: d.chainId,
    headBlock: head,
    indexer: { state, lastBlock: cursor, targetBlock: target, lagBlocks: cursor === null ? null : cursor >= target ? 0n : target - cursor, lagSeconds, maxLagSeconds: INDEXER_MAX_LAG_SEC },
    relayer: { hasGas, daysLeft },
    feeds: feeds.map((f) => ({ symbol: f.symbol, asset: f.asset, state: feedState(f, now), ageSeconds: Math.max(0, now - f.updatedAt), limitSeconds: f.maxStaleness })),
  };
}
