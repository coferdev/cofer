/**
 * New buys of a stock pause around a corporate action (bot /buy only). Selling, exit and leave are
 * never paused: members can always get out, and the pot's on-chain oracle floor bounds every sale.
 *  - the issuer has announced a multiplier change: paused until PENDING_WINDOW_SEC after it takes
 *    effect (fail closed: an announced change with no time stays paused)
 *  - the keeper's multiplier continuity alert is open for it: paused until the alert clears
 */
import { multiplierToWad } from "../stocks/canonical";
import { multiplierText, PENDING_WINDOW_SEC } from "./continuity";

export interface StockState {
  symbol: string;
  currentMultiplier: string | null;
  pendingMultiplier: string | null;
  pendingEffectiveAt: Date | null;
}

export function corporateActionPending(a: StockState, nowSec: number): boolean {
  if (!a.pendingMultiplier) return false;
  if (!a.pendingEffectiveAt) return true;
  return nowSec < Math.floor(a.pendingEffectiveAt.getTime() / 1000) + PENDING_WINDOW_SEC;
}

const shown = (m: string | null) => {
  try {
    return m ? multiplierText(multiplierToWad(m)) : "?";
  } catch {
    return "?";
  }
};
/** "2026-11-02 14:30 UTC" */
const when = (d: Date) => `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** Why a new buy of this stock is paused, or null if it is not. */
export function buyPause(a: StockState, continuityAlertOpen: boolean, nowSec: number): string | null {
  const still = "Selling and /exit are not affected.";
  if (corporateActionPending(a, nowSec)) {
    const at = a.pendingEffectiveAt ? ` on ${when(a.pendingEffectiveAt)}` : "";
    return `${a.symbol} has a corporate action coming (multiplier ${shown(a.currentMultiplier)} → ${shown(a.pendingMultiplier)}${at}). New buys of ${a.symbol} are paused until a few hours after it takes effect. ${still}`;
  }
  if (continuityAlertOpen) {
    return `${a.symbol}'s price and multiplier don't agree right now, so new buys of ${a.symbol} are paused until that is checked. ${still}`;
  }
  return null;
}

/** The short note /pot shows next to a held stock, or null. */
export function potNote(a: StockState, continuityAlertOpen: boolean, nowSec: number): string | null {
  if (corporateActionPending(a, nowSec)) return "corporate action pending, buys paused";
  if (continuityAlertOpen) return "price being checked, buys paused";
  return null;
}
