/**
 * Beta limit: a soft cap on a group's total value, checked by the signer site (and shown by the
 * bot) before a deposit. Front-end only: the contract does not enforce it. Exit, leave and every
 * other action never read it.
 *
 * The group's value is the pot's navUsdg(), the same number the contract prices deposits with.
 */
import { errorKind, revertName } from "./errors";

// The owner's setting: 5,000 USDG (6 decimals). Set to null to turn the limit off.
export const BETA_DEPOSIT_CAP_USDG: bigint | null = 5_000_000_000n;

/** USDG units as text with thousands separators, rounded down to the cent (never shows more room than there is). */
export function usdgText(units: bigint): string {
  const whole = (units / 1_000_000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const cents = (units % 1_000_000n) / 10_000n;
  return cents === 0n ? whole : `${whole}.${cents.toString().padStart(2, "0")}`;
}

/** How much more the group can take, or null when the limit is off. */
export function roomLeft(nav: bigint, cap = BETA_DEPOSIT_CAP_USDG): bigint | null {
  if (cap === null) return null;
  return nav >= cap ? 0n : cap - nav;
}

/** The line shown to members, or null when the limit is off. */
export function roomText(nav: bigint, cap = BETA_DEPOSIT_CAP_USDG): string | null {
  const room = roomLeft(nav, cap);
  if (room === null) return null;
  if (room === 0n) return `This group has reached the ${usdgText(cap!)} USDG beta limit.`;
  return `This group can take up to ${usdgText(room)} USDG more during the beta.`;
}

/** Why this deposit is refused, or null if it fits (or the limit is off). */
export function capRefusal(amount: bigint, nav: bigint, cap = BETA_DEPOSIT_CAP_USDG): string | null {
  const room = roomLeft(nav, cap);
  if (room === null || amount <= room) return null;
  return room === 0n ? roomText(nav, cap)! : `That's more than the beta limit allows. ${roomText(nav, cap)}`;
}

/** What the page says when the group's value cannot be read: refuse, never guess. */
export function navReadFailureText(e: unknown): string {
  if (errorKind(e) === "revert" && (revertName(e) === "StalePrice" || revertName(e) === "BadPrice")) {
    return "A price feed is paused, so the group's value can't be checked right now. Nothing was sent. Try again when the market reopens.";
  }
  return "Couldn't read the group's value just now. Nothing was sent. Try again in a minute.";
}
