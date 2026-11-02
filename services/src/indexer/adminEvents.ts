/**
 * Admin changes on CoferFactory and FeeRouter, as staff alerts (docs/alerts.md):
 *  - log only: listing and buyable flags (routine setup), the router's factory when it is the
 *    expected one, and every admin event from history (first start, or a block more than
 *    HISTORY_AGE_SEC old while the indexer catches up)
 *  - one short info line ("admin-change"): a change that matches the expected roles and settings
 *  - role-changed (EMERGENCY): an owner, guardian, fee sink, swap adapter or router factory that is
 *    not the expected one. Owner and guardian share the keeper's role check alert, which also
 *    clears it; the others clear when a later event puts the expected value back (or removes the adapter).
 * Changes QUEUED behind the 48h timelock (feed, swap adapter, swap fee) are also announced in every
 * group, so members can see what is coming and exit first if they disagree; from history only while
 * the change is still ahead. Texts are built only from the on-chain event; addresses are named or
 * shortened by the alert format. Pure apart from the injected deps.
 */
import type { Address, Hex } from "viem";
import { utcText } from "./unknownVotes";
import { WHO, type AlertMessage } from "../core/alertFormat";
import { ROLES_ALERT } from "../core/roles";

/** An admin event older than this (by its block time) is history: logged, not posted. */
export const HISTORY_AGE_SEC = 600;

export type AdminSource = "factory" | "feeRouter";

export interface AdminEvent {
  source: AdminSource;
  name: string;
  args: Record<string, unknown>;
  txHash: Hex;
}

/** The expected roles and settings; an unset owner, guardian or fee wallet is not judged. */
export interface AdminExpected {
  owner?: string;
  guardian?: string;
  feeWallet?: string;
  adapter: string;
  factory: string;
}

export interface AdminEventDeps {
  expected: AdminExpected;
  now(): number;
  /** Every group chat that has a pot. */
  groupChats(): Promise<number[]>;
  sendGroup(chatId: number, text: string): Promise<void>;
  /** A listed asset's symbol, or null if unknown (the address is shown instead). */
  symbolOf(asset: Address): Promise<string | null>;
  /** Posts one message to the staff chat; throws if it could not be delivered. */
  post(m: AlertMessage): Promise<void>;
  /** Opens an alert (nothing if already open); throws if it could not be delivered. */
  openAlert(key: string, m: AlertMessage): Promise<void>;
  /** Clears an open alert with a reason (nothing if not open). */
  clearAlert(key: string, note: string): Promise<void>;
  /** The log only. */
  log(text: string): void;
}

export interface AdminDecision {
  level: "log" | "info" | "emergency";
  what: string;
  who: string;
  /** emergency: the alert it opens. */
  key?: string;
  /** A change back to the expected value: the alert it clears. */
  clears?: { key: string; note: string };
}

const s = (v: unknown) => String(v);
const pct = (bps: unknown) => `${Number(bps) / 100}%`;
const hours = (secs: unknown) => `${Number(secs) / 3600}h`;
const same = (a: unknown, b: string) => s(a).toLowerCase() === b.toLowerCase();
/** True when there is no expectation, or `a` matches it. */
const ok = (a: unknown, expected?: string) => expected === undefined || same(a, expected);

export const adapterAlertKey = (adapter: string) => `role-changed:adapter:${adapter.toLowerCase()}`;
export const SINKS_ALERT = "role-changed:sinks";
export const ROUTER_FACTORY_ALERT = "role-changed:router-factory";

const info = (what: string, who: string = WHO.none): AdminDecision => ({ level: "info", what, who });
const log = (what: string): AdminDecision => ({ level: "log", what, who: "" });
const emergency = (key: string, what: string): AdminDecision => ({ level: "emergency", key, what, who: WHO.emergency });

/** What to do with an admin event, or null if it is not an admin change. */
export function adminDecision(ev: AdminEvent, x: AdminExpected, asset?: string): AdminDecision | null {
  const a = ev.args;
  const what = asset ?? s(a.asset);
  if (ev.source === "factory") {
    switch (ev.name) {
      case "OwnershipTransferStarted":
        return ok(a.to, x.owner)
          ? info(`A factory ownership transfer to ${s(a.to)} started. It completes when ${s(a.to)} accepts it.`)
          : emergency(ROLES_ALERT, `A factory ownership transfer to ${s(a.to)} started. That is not the owner Safe.`);
      case "OwnershipTransferred":
        return ok(a.to, x.owner) ? info(`The factory owner is now ${s(a.to)}.`) : emergency(ROLES_ALERT, `The factory owner is now ${s(a.to)}, not the owner Safe.`);
      case "GuardianSet":
        return ok(a.guardian, x.guardian) ? info(`The guardian is now ${s(a.guardian)}.`) : emergency(ROLES_ALERT, `The guardian was changed to ${s(a.guardian)}, which is not the expected guardian.`);
      case "DepositsPaused":
        return a.paused
          ? info("Deposits are paused in every pot. Exits are not affected.", "Tell the groups. If nobody planned this pause, tell the owner and the dev at once.")
          : info("Deposits are open again in every pot.");
      case "CreationPaused":
        return a.paused
          ? info("New pots are paused. Existing pots are not affected.", "If nobody planned this pause, tell the owner and the dev at once.")
          : info("New pots are allowed again.");
      case "AssetListed":
        return log(`Asset listed: ${what} with feed ${s(a.feed)}, staleness limit ${hours(a.maxStaleness)}, ${a.isStock ? "stock" : "not a stock"}.`);
      case "AssetBuyable":
        return log(`New buys of ${what} ${a.buyable ? "allowed" : "stopped"}.`);
      case "FeedQueued":
        return info(`A new price feed for ${what} was queued (staleness limit ${hours(a.maxStaleness)}). It can apply after ${utcText(a.eta as bigint)}. The groups were told.`);
      case "FeedApplied":
        return info(`The new price feed for ${what} is now in use (staleness limit ${hours(a.maxStaleness)}).`);
      case "AdapterQueued":
        return same(a.adapter, x.adapter)
          ? info(`The swap adapter was queued. It can be allowed after ${utcText(a.eta as bigint)}. The groups were told.`)
          : emergency(adapterAlertKey(s(a.adapter)), `A swap adapter that is not the expected one (${s(a.adapter)}) was queued. It can be allowed after ${utcText(a.eta as bigint)}.`);
      case "AdapterSet":
        if (!a.allowed) return { ...info(`Swap adapter ${s(a.adapter)} was removed.`), clears: { key: adapterAlertKey(s(a.adapter)), note: "that adapter was removed" } };
        return same(a.adapter, x.adapter)
          ? info("The swap adapter is now allowed.")
          : emergency(adapterAlertKey(s(a.adapter)), `A swap adapter that is not the expected one (${s(a.adapter)}) is now allowed.`);
      case "SwapFeeQueued":
        return info(`A swap fee change to ${pct(a.bps)} was queued. It can apply after ${utcText(a.eta as bigint)}. The groups were told.`);
      case "SwapFeeSet":
        return info(`The swap fee is now ${pct(a.bps)}.`);
      default:
        return null; // PotCreated and anything else: not an admin change
    }
  }
  switch (ev.name) {
    case "SinksSet": {
      const sinks = a.sinks as readonly string[];
      const list = sinks.map((sink, i) => `${sink} ${pct((a.bps as readonly number[])[i])}`).join(", ");
      if (sinks.every((sink) => ok(sink, x.feeWallet))) {
        return { ...info(`Fee sinks set: ${list}.`), clears: { key: SINKS_ALERT, note: "the fee sinks are the fee wallet again" } };
      }
      return emergency(SINKS_ALERT, `Fee sinks were changed: ${list}. Not all of them are the fee wallet.`);
    }
    case "PlanPriceSet":
      return info(`The group plan price is now ${Number(a.pricePerMonth) / 1e6} USDG a month (plan votes keep the maximum cost members signed).`);
    case "FactorySet":
      return same(a.factory, x.factory)
        ? { ...log(`Fee router wired to the factory ${s(a.factory)}.`), clears: { key: ROUTER_FACTORY_ALERT, note: "the fee router points at the factory again" } }
        : emergency(ROUTER_FACTORY_ALERT, `The fee router was wired to ${s(a.factory)}, which is not the factory.`);
    default:
      return null; // PlanPaid, Distributed: not admin changes
  }
}

/** The group notice for a change queued behind the 48h timelock, or null for anything else. */
export function adminGroupText(ev: AdminEvent, asset?: string): string | null {
  if (ev.source !== "factory") return null;
  const a = ev.args;
  const tail = "Nothing changes before then. If you disagree, you can /exit with your exact share at any time.";
  switch (ev.name) {
    case "FeedQueued":
      return `Heads-up: the studio queued a new price feed for ${asset ?? s(a.asset)}. It can take effect after ${utcText(a.eta as bigint)}. ${tail}`;
    case "AdapterQueued":
      return `Heads-up: the studio queued a new swap adapter (${s(a.adapter)}). It can take effect after ${utcText(a.eta as bigint)}. ${tail}`;
    case "SwapFeeQueued":
      return `Heads-up: the studio queued a swap fee change to ${pct(a.bps)}. It can take effect after ${utcText(a.eta as bigint)}. ${tail}`;
    default:
      return null;
  }
}

/**
 * Handles one admin event.
 * @param isNew   false when this log was already recorded (a re-run): nothing is sent twice.
 * @param history true on first start or while catching up on old blocks: logged, never posted.
 */
export async function onAdminEvent(deps: AdminEventDeps, ev: AdminEvent, isNew: boolean, history = false): Promise<"alerted" | "logged" | "skipped"> {
  if (!isNew) return "skipped";
  const asset = typeof ev.args.asset === "string" ? ((await deps.symbolOf(ev.args.asset as Address)) ?? undefined) : undefined;
  const d = adminDecision(ev, deps.expected, asset);
  if (d === null) return "skipped";

  const label = asset && typeof ev.args.asset === "string" ? `${asset} (${ev.args.asset})` : undefined;
  const group = adminGroupText(ev, label);
  const ahead = typeof ev.args.eta === "bigint" && Number(ev.args.eta) > deps.now();
  if (group !== null && (!history || ahead)) for (const chat of await deps.groupChats()) await deps.sendGroup(chat, group);

  if (d.clears) await deps.clearAlert(d.clears.key, d.clears.note);
  if (history || d.level === "log") {
    deps.log(`admin event${history ? " (history)" : ""}: ${d.what} (tx ${ev.txHash})`);
    return "logged";
  }
  if (d.level === "emergency") await deps.openAlert(d.key!, { name: "role-changed", what: d.what, who: d.who, emergency: true, tx: ev.txHash });
  else await deps.post({ name: "admin-change", what: d.what, who: d.who, tx: ev.txHash });
  return "alerted";
}
