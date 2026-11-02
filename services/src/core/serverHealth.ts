/**
 * Server health rules (keeper, every minute): rpc-down, errors-spike, disk-low, memory-high.
 * Pure. Each returns the alert text while the problem holds, else null. Where a value hovers near
 * its limit, the alert opens at one level and clears at a safer one, so it does not flap.
 */
import { ageText } from "./feedHealth";

// The owner's settings.
export const RPC_DOWN_AFTER_SEC = 5 * 60; // the chain RPC failing this long without a break
export const RPC_GRACE_SEC = 5 * 60; // after it answers again, held-back alerts wait this long
export const ERRORS_WINDOW_SEC = 5 * 60;
export const ERRORS_SPIKE_AT = 20; // logged errors in the window, all processes together
export const ERRORS_CLEAR_BELOW = 10;
export const DISK_LOW_BELOW = 0.1; // free fraction
export const DISK_CLEAR_AT = 0.12;
export const MEMORY_HIGH_ABOVE = 0.9; // used fraction
export const MEMORY_HIGH_FOR_SEC = 5 * 60;
export const MEMORY_CLEAR_BELOW = 0.85;

const pct = (f: number) => `${Math.round(f * 100)}%`;

/** `failingSince`: when the RPC started failing without a break (unix seconds), or null if it answers. */
export function rpcDownProblem(failingSince: number | null, now: number): string | null {
  if (failingSince === null || now - failingSince < RPC_DOWN_AFTER_SEC) return null;
  return `The chain RPC has not answered for ${ageText(now - failingSince)}. The bot, indexer and keeper cannot read the chain, so balances and votes may not update and passed votes wait. Funds in the contracts are not affected.`;
}

export function errorsSpikeProblem(count: number, open: boolean): string | null {
  if (count < (open ? ERRORS_CLEAR_BELOW : ERRORS_SPIKE_AT)) return null;
  return `${count} errors were logged in the last ${ageText(ERRORS_WINDOW_SEC)} across the bot, API and jobs. Single errors stay in the log only.`;
}

export function diskLowProblem(freeFraction: number, open: boolean): string | null {
  if (freeFraction >= (open ? DISK_CLEAR_AT : DISK_LOW_BELOW)) return null;
  return `The server has ${pct(freeFraction)} disk space left. When it is full, the database and logs stop working.`;
}

/** `highSince`: when memory use first went above MEMORY_HIGH_ABOVE without dropping back, or null. */
export function memoryHighProblem(usedFraction: number, highSince: number | null, now: number, open: boolean): string | null {
  if (open) return usedFraction < MEMORY_CLEAR_BELOW ? null : `The server is using ${pct(usedFraction)} of its memory.`;
  if (usedFraction <= MEMORY_HIGH_ABOVE || highSince === null || now - highSince < MEMORY_HIGH_FOR_SEC) return null;
  return `The server has used more than ${pct(MEMORY_HIGH_ABOVE)} of its memory for ${ageText(now - highSince)} (now ${pct(usedFraction)}). Processes may be stopped by the system.`;
}

/** The next `highSince` after a reading. */
export function nextHighSince(usedFraction: number, highSince: number | null, now: number): number | null {
  return usedFraction > MEMORY_HIGH_ABOVE ? (highSince ?? now) : null;
}
