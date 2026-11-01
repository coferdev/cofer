/**
 * Admin changes on CoferFactory and FeeRouter, turned into alerts. Every change goes to the ops chat.
 * Changes that are QUEUED behind the 48h timelock (feed, swap adapter, swap fee) are also announced in
 * every group: the delay exists so members can see what is coming and exit first if they disagree.
 * Texts are built only from the on-chain event. Pure apart from the injected deps.
 */
import type { Address, Hex } from "viem";
import { utcText } from "./unknownVotes";

export type AdminSource = "factory" | "feeRouter";

export interface AdminEvent {
  source: AdminSource;
  name: string;
  args: Record<string, unknown>;
  txHash: Hex;
}

export interface AdminEventDeps {
  sendOps(text: string): Promise<void>;
  /** Every group chat that has a pot. */
  groupChats(): Promise<number[]>;
  sendGroup(chatId: number, text: string): Promise<void>;
  /** A listed asset's symbol, or null if unknown (the address is shown instead). */
  symbolOf(asset: Address): Promise<string | null>;
}

const s = (v: unknown) => String(v);
const pct = (bps: unknown) => `${Number(bps) / 100}%`;
const hours = (secs: unknown) => `${Number(secs) / 3600}h`;

/** The ops-chat line for an admin event, or null if the event is not an admin change. */
export function adminOpsText(ev: AdminEvent, asset?: string): string | null {
  const a = ev.args;
  const tx = ` (tx ${ev.txHash})`;
  const what = asset ?? s(a.asset);
  if (ev.source === "factory") {
    switch (ev.name) {
      case "OwnershipTransferStarted":
        return `Factory ownership transfer STARTED: ${s(a.from)} -> ${s(a.to)}. It completes when ${s(a.to)} calls acceptOwnership.${tx}`;
      case "OwnershipTransferred":
        return `Factory owner is now ${s(a.to)} (was ${s(a.from)}).${tx}`;
      case "GuardianSet":
        return `Factory guardian set to ${s(a.guardian)}.${tx}`;
      case "DepositsPaused":
        return `${a.paused ? "Deposits PAUSED" : "Deposits UNPAUSED"} in every pot. Exits are not affected.${tx}`;
      case "CreationPaused":
        return `${a.paused ? "New pots PAUSED" : "New pots UNPAUSED"}.${tx}`;
      case "AssetListed":
        return `Asset listed: ${what} with feed ${s(a.feed)}, staleness limit ${hours(a.maxStaleness)}, ${a.isStock ? "stock" : "not a stock"}.${tx}`;
      case "AssetBuyable":
        return `New buys of ${what} ${a.buyable ? "ALLOWED" : "STOPPED"}.${tx}`;
      case "FeedQueued":
        return `Price feed change QUEUED for ${what}: ${s(a.feed)}, staleness limit ${hours(a.maxStaleness)}, can apply after ${utcText(a.eta as bigint)}.${tx}`;
      case "FeedApplied":
        return `Price feed change APPLIED for ${what}: ${s(a.feed)}, staleness limit ${hours(a.maxStaleness)}.${tx}`;
      case "AdapterQueued":
        return `Swap adapter QUEUED: ${s(a.adapter)}, can apply after ${utcText(a.eta as bigint)}.${tx}`;
      case "AdapterSet":
        return `Swap adapter ${s(a.adapter)} ${a.allowed ? "ALLOWED" : "REMOVED"}.${tx}`;
      case "SwapFeeQueued":
        return `Swap fee change QUEUED: ${pct(a.bps)}, can apply after ${utcText(a.eta as bigint)}.${tx}`;
      case "SwapFeeSet":
        return `Swap fee is now ${pct(a.bps)}.${tx}`;
      default:
        return null; // PotCreated and anything else: not an admin change
    }
  }
  switch (ev.name) {
    case "SinksSet":
      return `Fee sinks set: ${(a.sinks as readonly string[]).map((x, i) => `${x} ${pct((a.bps as readonly number[])[i])}`).join(", ")}.${tx}`;
    case "PlanPriceSet":
      return `Group plan price is now ${Number(a.pricePerMonth) / 1e6} USDG a month (applies to plan votes that have not executed yet).${tx}`;
    case "FactorySet":
      return `Fee router wired to factory ${s(a.factory)}.${tx}`;
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
 * Sends the alerts for one admin event.
 * @param isNew false when this log was already recorded (a re-run): nothing is sent twice.
 */
export async function onAdminEvent(deps: AdminEventDeps, ev: AdminEvent, isNew: boolean): Promise<"alerted" | "skipped"> {
  if (!isNew) return "skipped";
  const asset = typeof ev.args.asset === "string" ? ((await deps.symbolOf(ev.args.asset as Address)) ?? undefined) : undefined;
  const label = asset && typeof ev.args.asset === "string" ? `${asset} (${ev.args.asset})` : undefined;
  const ops = adminOpsText(ev, label);
  if (ops === null) return "skipped";
  const group = adminGroupText(ev, label);
  if (group !== null) for (const chat of await deps.groupChats()) await deps.sendGroup(chat, group);
  await deps.sendOps(ops);
  return "alerted";
}
