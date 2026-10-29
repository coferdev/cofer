/**
 * Exact mirrors of CoferPot share math (bigint, same rounding). Used for previews in the bot and
 * signer page, and tested against the contract formulas.
 */

export const VIRTUAL_SHARES = 10n ** 12n;
export const VIRTUAL_ASSETS = 1n;
const BPS = 10_000n;

/** shares minted for `amount` USDG at `nav` (USDG units), rounding down (in favour of the pot). */
export function previewDeposit(args: {
  amount: bigint;
  nav: bigint;
  nonUsdgValue: bigint;
  totalShares: bigint;
  entrySpreadBps: number;
}): bigint {
  const { amount, nav, nonUsdgValue, totalShares, entrySpreadBps } = args;
  if (amount <= 0n) return 0n;
  let effective = amount;
  if (nonUsdgValue > 0n && entrySpreadBps > 0) effective = (amount * (BPS - BigInt(entrySpreadBps))) / BPS;
  return (effective * (totalShares + VIRTUAL_SHARES)) / (nav + VIRTUAL_ASSETS);
}

/** In-kind exit: floor(distributable_i * shares / totalShares) for every held asset. */
export function previewExit(shares: bigint, totalShares: bigint, distributable: bigint[]): bigint[] {
  if (totalShares === 0n || shares === 0n || shares > totalShares) return distributable.map(() => 0n);
  return distributable.map((d) => (d * shares) / totalShares);
}

/** A member's current claim, valued (USDG units) given per-asset values of the whole pot. */
export function memberValue(shares: bigint, totalShares: bigint, potAssetValues: bigint[]): bigint {
  if (totalShares === 0n) return 0n;
  return potAssetValues.reduce((acc, v) => acc + (v * shares) / totalShares, 0n);
}

export interface AllowanceState {
  allowance: bigint;
  period: number; // seconds, 0 = none
  periodStart: number; // unix seconds
  spent: bigint;
}

/** Mirrors CoferPot._rollWindow + allowanceLeft. */
export function rollWindow(s: AllowanceState, now: number): AllowanceState {
  if (s.period === 0) return s;
  if (now >= s.periodStart + s.period) {
    const periods = Math.floor((now - s.periodStart) / s.period);
    return { ...s, periodStart: s.periodStart + periods * s.period, spent: 0n };
  }
  return s;
}

export function allowanceLeft(s: AllowanceState, now: number): bigint {
  if (s.period === 0 || s.allowance === 0n) return 0n;
  const r = rollWindow(s, now);
  return r.spent >= r.allowance ? 0n : r.allowance - r.spent;
}

export function nextResetAt(s: AllowanceState, now: number): number | null {
  if (s.period === 0) return null;
  const r = rollWindow(s, now);
  return r.periodStart + r.period;
}
