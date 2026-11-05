/**
 * Large-outflow alert (keeper, every 5 minutes): more than OUTFLOW_ALERT_USDG worth leaving group
 * accounts within OUTFLOW_WINDOW_SEC, across all pots. It only tells staff; nothing is paused and
 * exits are never affected. Who acts: the dev checks it is real activity.
 *
 * What counts as leaving a pot, from the pot's own events (stored by the indexer):
 *  - Exited:        each asset paid out, minus any part set aside in the same transaction (ExitOwed)
 *  - OwedClaimed:   a set-aside token, when it is finally paid out
 *  - Transferred:   a voted transfer
 *  - AllowanceSpent: USDG spent from a member's allowance
 *  - PlanPaid:      USDG paid for the group plan
 * Swaps are not outflows: the value stays in the pot.
 */
import type { AlertMessage } from "./alertFormat";
import { usdgText } from "./betaCap";

export const OUTFLOW_ALERT = "large-outflow";
// The owner's settings: alert above 5,000 USDG (6 decimals) leaving pots within one hour.
export const OUTFLOW_ALERT_USDG = 5_000_000_000n;
export const OUTFLOW_WINDOW_SEC = 3600;
export const OUTFLOW_WHO = "Dev checks it is real activity.";
/** The pot events read for this check. */
export const OUTFLOW_EVENTS = ["Exited", "ExitOwed", "OwedClaimed", "Transferred", "AllowanceSpent", "PlanPaid"] as const;

/** One stored pot event (chain_events): `args` as the indexer saved them (big numbers as strings). */
export interface PotEvent {
  pot: string;
  name: string;
  args: Record<string, unknown>;
  txHash: string;
}

export interface Outflow {
  pot: string;
  asset: string;
  amount: bigint;
  txHash: string;
}

const big = (v: unknown) => BigInt(String(v ?? "0"));
const lc = (v: unknown) => String(v ?? "").toLowerCase();

/** The amounts that left pots, per the rules above. `usdg` is the USDG address (allowance and plan payments). */
export function outflowsOf(events: PotEvent[], usdg: string): Outflow[] {
  // set aside during an exit, per transaction + asset + account: not paid out yet
  const owed = new Map<string, bigint>();
  for (const e of events) {
    if (e.name !== "ExitOwed") continue;
    const k = `${lc(e.txHash)}|${lc(e.args.asset)}|${lc(e.args.account)}`;
    owed.set(k, (owed.get(k) ?? 0n) + big(e.args.amount));
  }
  const out: Outflow[] = [];
  const push = (e: PotEvent, asset: unknown, amount: bigint) => {
    if (amount > 0n) out.push({ pot: e.pot, asset: String(asset), amount, txHash: e.txHash });
  };
  for (const e of events) {
    switch (e.name) {
      case "Exited": {
        const assets = (e.args.assets as unknown[]) ?? [];
        const amounts = (e.args.amounts as unknown[]) ?? [];
        assets.forEach((a, i) => {
          const k = `${lc(e.txHash)}|${lc(a)}|${lc(e.args.to)}`;
          const held = owed.get(k) ?? 0n;
          const amt = big(amounts[i]);
          const setAside = held < amt ? held : amt;
          if (setAside > 0n) owed.set(k, held - setAside);
          push(e, a, amt - setAside);
        });
        break;
      }
      case "OwedClaimed":
      case "Transferred":
        push(e, e.args.asset, big(e.args.amount));
        break;
      case "AllowanceSpent":
        push(e, usdg, big(e.args.amount));
        break;
      case "PlanPaid":
        push(e, usdg, big(e.args.cost));
        break;
    }
  }
  return out;
}

/**
 * The fallback price when the oracle refuses (stale feed): the value the keeper last recorded for the
 * pot's holding of that asset, pro rata. null when there is no recorded value.
 */
export function valueFromHolding(amount: bigint, h: { rawBalance: string; valueUsdg: string | null } | undefined): bigint | null {
  if (!h?.valueUsdg) return null;
  const raw = BigInt(h.rawBalance);
  return raw === 0n ? null : (amount * BigInt(h.valueUsdg)) / raw;
}

/** USDG value (6 decimals) of `amount` of `asset` held by `pot`, or null when it cannot be priced. */
export type Pricer = (o: Outflow) => Promise<bigint | null>;

export interface OutflowSummary {
  totalUsdg: bigint;
  pots: number;
  /** The pot that lost the most, and how much. */
  topPot: string | null;
  topPotUsdg: bigint;
  /** The transaction of the largest single outflow (shown as an explorer link). */
  topTx: string | null;
  /** Outflows that could not be priced (not in the total). */
  unpriced: number;
}

export async function summarize(outflows: Outflow[], price: Pricer): Promise<OutflowSummary> {
  const byPot = new Map<string, bigint>();
  let totalUsdg = 0n;
  let unpriced = 0;
  let topTx: string | null = null;
  let topOne = -1n;
  for (const o of outflows) {
    const v = await price(o);
    if (v === null) {
      unpriced++;
      continue;
    }
    totalUsdg += v;
    byPot.set(lc(o.pot), (byPot.get(lc(o.pot)) ?? 0n) + v);
    if (v > topOne) {
      topOne = v;
      topTx = o.txHash;
    }
  }
  let topPot: string | null = null;
  let topPotUsdg = 0n;
  for (const [p, v] of byPot) {
    if (v > topPotUsdg) {
      topPot = p;
      topPotUsdg = v;
    }
  }
  return { totalUsdg, pots: byPot.size, topPot, topPotUsdg, topTx, unpriced };
}

/** The alert while more than the limit left pots in the window, else null (which clears an open one). */
export function outflowAlert(s: OutflowSummary, potName: (pot: string) => string): AlertMessage | null {
  if (s.totalUsdg <= OUTFLOW_ALERT_USDG) return null;
  const pots = s.pots === 1 ? "1 group account" : `${s.pots} group accounts`;
  const top = s.topPot && s.pots > 1 ? `; largest: ${potName(s.topPot)}, ${usdgText(s.topPotUsdg)} USDG` : s.topPot ? ` (${potName(s.topPot)})` : "";
  const unpriced = s.unpriced ? ` ${s.unpriced} more could not be priced right now and are not in that total.` : "";
  return {
    name: OUTFLOW_ALERT,
    what: `${usdgText(s.totalUsdg)} USDG worth left ${pots} in the last hour${top}.${unpriced} Exits are never paused; this alert only reports it.`,
    who: OUTFLOW_WHO,
    ...(s.topTx ? { tx: s.topTx } : {}),
  };
}
