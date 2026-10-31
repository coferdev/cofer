/**
 * Indexer lag check (keeper ops job, every 5 minutes). The keeper is a separate process, so a dead
 * or stuck indexer cannot hide its own failure. Lag is measured in chain time: the block the
 * indexer should have reached (head minus CONFIRMATIONS) against the last block it saved.
 */
import { ageText } from "./feedHealth";

// The owner's setting.
export const INDEXER_MAX_LAG_SEC = 300; // 5 minutes

/** The alert's name (the keeper's ops job opens it; the health ping reads it). */
export const INDEXER_LAG_ALERT = "indexer-behind";

/** The alert text while the indexer is too far behind (or has never saved a block), or null. */
export function indexerLagProblem(
  s: { cursor: bigint | null; target: bigint; cursorTime: number | null; targetTime: number },
  maxLagSec = INDEXER_MAX_LAG_SEC,
): string | null {
  const effect = "Votes, members and balances shown by the bot may be out of date. Exits and the contracts are not affected.";
  if (s.cursor === null || s.cursorTime === null) return `The indexer has not saved any block yet (chain at ${s.target}). ${effect}`;
  if (s.cursor >= s.target) return null;
  const lag = s.targetTime - s.cursorTime;
  if (lag <= maxLagSec) return null;
  return `The indexer is ${ageText(lag)} behind the chain (last indexed block ${s.cursor}, chain at ${s.target}). ${effect}`;
}
