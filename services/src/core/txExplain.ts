/**
 * Explains a transaction in plain words: what each Cofer contract in it did, with every amount and address.
 * Only logs from Cofer contracts are read (the factory, the fee router, and group accounts the factory confirms with
 * isPot). Any other log (token transfers, other contracts) is left out, never guessed at. A transaction with no
 * Cofer log is "not a Cofer transaction".
 */
import { decodeEventLog, formatUnits, getAddress, type Address, type Hex } from "viem";
import { coferFactoryAbi, coferPotAbi, feeRouterAbi } from "../chain/abi";
import { Kind } from "./proposal";

export interface TxLog {
  address: Address;
  topics: readonly Hex[];
  data: Hex;
  logIndex: number;
}

export interface TxReceiptLike {
  transactionHash: Hex;
  blockNumber: bigint;
  status: "success" | "reverted";
  from: Address;
  to: Address | null;
  logs: TxLog[];
}

export interface ExplainDeps {
  factory: Address;
  feeRouter: Address;
  /** The USDG the factory, its group accounts and the fee router use. */
  usdg: Address;
  /** True when the factory made this address (factory.isPot). */
  isPot(a: Address): Promise<boolean>;
  /** A token's symbol and decimals, or null if it cannot be read. */
  token(a: Address): Promise<{ symbol: string; decimals: number } | null>;
}

export type ContractRole = "group account" | "factory" | "fee router";
export type TxKind = "deposit" | "exit" | "allowance spend" | "claim" | "swap" | "vote executed" | "vote queued" | "group created" | "plan payment" | "admin change" | "group settings" | "fee distribution" | "other Cofer";

export interface ExplainedEvent {
  contract: ContractRole;
  address: Address;
  event: string;
  logIndex: number;
  text: string;
  args: Record<string, unknown>;
}

export interface Explanation {
  hash: Hex;
  cofer: boolean;
  status: "succeeded" | "failed";
  block: bigint;
  time: number | null; // unix seconds
  from: Address;
  to: Address | null;
  kind: TxKind | null;
  summary: string;
  events: ExplainedEvent[];
}

export const KIND_NAMES: Record<number, string> = {
  [Kind.TRANSFER]: "send",
  [Kind.SWAP]: "swap",
  [Kind.ADD_MEMBER]: "add a member",
  [Kind.REMOVE_MEMBER]: "remove a member",
  [Kind.SET_ALLOWANCE]: "set an allowance",
  [Kind.SET_THRESHOLD]: "change the approval threshold",
  [Kind.SET_CONFIG]: "change the group's settings",
  [Kind.PAY_PLAN]: "pay the plan",
};

const ORDER: TxKind[] = ["deposit", "exit", "allowance spend", "claim", "swap", "vote executed", "vote queued", "group created", "plan payment", "fee distribution", "admin change", "group settings", "other Cofer"];

const utc = (t: bigint | number) => `${new Date(Number(t) * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
const pct = (bps: unknown) => `${Number(bps) / 100}%`;
const hrs = (s: unknown) => {
  const h = Number(s) / 3600;
  return `${Number.isInteger(h) ? h : h.toFixed(2)} h`;
};
const a = (x: unknown) => getAddress(String(x));
/** Pot shares have 18 decimals (1 USDG first deposited mints 1e18 shares). */
const shares = (x: unknown) => `${formatUnits(BigInt(x as bigint), 18)} shares`;
/** The pot's rule (CoferPot.requiredVotes): a share of members, rounded up, when thresholdBps > 0; else the fixed count. */
const needs = (threshold: unknown, bps: unknown) => (Number(bps) > 0 ? `${pct(bps)} of members to approve (rounded up)` : `${threshold} approval(s)`);

/** JSON-ready copies of decoded arguments: big numbers as decimal strings. */
function plain(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
}

export async function explainReceipt(r: TxReceiptLike, d: ExplainDeps, time: number | null = null): Promise<Explanation> {
  const factory = d.factory.toLowerCase();
  const router = d.feeRouter.toLowerCase();
  const potCache = new Map<string, boolean>();
  const isPot = async (x: Address) => {
    const k = x.toLowerCase();
    if (!potCache.has(k)) potCache.set(k, await d.isPot(x));
    return potCache.get(k)!;
  };
  const amt = async (token: unknown, raw: unknown) => {
    const t = await d.token(a(token));
    const v = BigInt(raw as bigint);
    return t ? `${formatUnits(v, t.decimals)} ${t.symbol}` : `${v} raw units of token ${a(token)}`;
  };

  const events: (ExplainedEvent & { kind: TxKind })[] = [];
  for (const log of r.logs) {
    const addr = log.address.toLowerCase();
    const role: ContractRole | null = addr === factory ? "factory" : addr === router ? "fee router" : (await isPot(log.address)) ? "group account" : null;
    if (!role) continue; // not a Cofer contract: left out
    const abi = role === "factory" ? coferFactoryAbi : role === "fee router" ? feeRouterAbi : coferPotAbi;
    let ev: { eventName: string; args: Record<string, unknown> };
    try {
      ev = decodeEventLog({ abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] }) as unknown as typeof ev;
    } catch {
      continue; // a log this contract version does not define: left out
    }
    const g = a(log.address);
    const x = ev.args;
    let text: string;
    let kind: TxKind;
    switch (`${role}:${ev.eventName}`) {
      case "group account:Deposited":
        kind = "deposit";
        text = `${a(x.member)} deposited ${await amt(d.usdg, x.amount)} into group account ${g} and received ${shares(x.shares)}.`;
        break;
      case "group account:Exited": {
        kind = "exit";
        const assets = x.assets as Address[];
        const amounts = x.amounts as bigint[];
        const parts = await Promise.all(assets.map((t, i) => amt(t, amounts[i])));
        text = `${a(x.member)} exited group account ${g} with ${shares(x.shares)}, paid out to ${a(x.to)}: ${parts.length ? parts.join(", ") : "nothing"}.`;
        break;
      }
      case "group account:ExitOwed":
        kind = "exit";
        text = `${await amt(x.asset, x.amount)} could not be sent to ${a(x.account)} during the exit, so it was set aside for them to claim later.`;
        break;
      case "group account:OwedClaimed":
        kind = "claim";
        text = `${a(x.account)} claimed ${await amt(x.asset, x.amount)} that had been set aside for them in group account ${g}.`;
        break;
      case "group account:AllowanceSpent":
        kind = "allowance spend";
        text = `${a(x.member)} spent ${await amt(d.usdg, x.amount)} of their allowance from group account ${g}, to ${a(x.to)}. Left this period: ${await amt(d.usdg, x.remaining)}.`;
        break;
      case "group account:Swapped":
        kind = "swap";
        text = `Group account ${g} swapped ${await amt(x.tokenIn, x.amountIn)} for ${await amt(x.tokenOut, x.amountOut)} through adapter ${a(x.adapter)} (swap fee ${await amt(x.tokenIn, x.fee)}).`;
        break;
      case "group account:Transferred":
        kind = "vote executed";
        text = `Group account ${g} sent ${await amt(x.asset, x.amount)} to ${a(x.to)}, as voted.`;
        break;
      case "group account:ProposalExecuted":
        kind = "vote executed";
        text = `A vote to ${KIND_NAMES[Number(x.kind)] ?? `do action ${x.kind}`} ran in group account ${g}, with ${x.approvals} approval(s). Vote id ${x.digest}.`;
        break;
      case "group account:ProposalQueued":
        kind = "vote queued";
        text = `A vote to ${KIND_NAMES[Number(x.kind)] ?? `do action ${x.kind}`} passed in group account ${g} and waits for the exit window: it can run after ${utc(x.eta as bigint)}. Members who disagree can exit before then. Vote id ${x.digest}.`;
        break;
      case "group account:VoteRevoked":
        kind = "group settings";
        text = `${a(x.member)} withdrew their approval of vote ${x.digest} in group account ${g}.`;
        break;
      case "group account:MemberAdded":
        kind = "group settings";
        text = `${a(x.member)} became a member of group account ${g}.`;
        break;
      case "group account:MemberRemoved":
        kind = "group settings";
        text = `${a(x.member)} is no longer a member of group account ${g}.`;
        break;
      case "group account:AllowanceSet":
        kind = "group settings";
        text = `${a(x.member)} now has an allowance of ${await amt(d.usdg, x.amount)} every ${hrs(x.period)} in group account ${g}.`;
        break;
      case "group account:ThresholdSet":
        kind = "group settings";
        text = `Group account ${g} now needs ${needs(x.threshold, x.thresholdBps)}.`;
        break;
      case "group account:ConfigSet":
        kind = "group settings";
        text = `Group account ${g} settings: exit window ${hrs(x.guardDelay)}, swap price limit ${pct(x.maxSlipBps)}, entry spread ${pct(x.entrySpreadBps)}, deposits ${x.depositsOpen ? "open" : "closed"}.`;
        break;
      case "group account:Initialized":
        kind = "group created";
        text = `Group account ${g} was set up with ${(x.members as Address[]).length} member(s): ${(x.members as Address[]).map(a).join(", ")}.`;
        break;
      case "group account:AssetAdded":
        kind = "group settings";
        text = `Group account ${g} now holds ${await tokenName(d, x.asset)}.`;
        break;
      case "group account:AssetRemoved":
        kind = "group settings";
        text = `Group account ${g} no longer holds ${await tokenName(d, x.asset)}.`;
        break;
      case "group account:EpochBumped":
        kind = "group settings";
        text = `Group account ${g}'s membership changed, so open votes signed before it need signing again (round ${x.epoch}).`;
        break;
      case "group account:PlanPaid":
        kind = "plan payment";
        text = `Group account ${g} paid the plan for ${x.months} month(s): ${await amt(d.usdg, x.cost)}.`;
        break;
      case "factory:PotCreated":
        kind = "group created";
        text = `The factory created group account ${a(x.pot)} for creator ${a(x.creator)}, with ${(x.members as Address[]).length} member(s); a vote needs ${needs(x.threshold, x.thresholdBps)}.`;
        break;
      case "factory:OwnershipTransferStarted":
        kind = "admin change";
        text = `The factory's owner ${a(x.from)} offered ownership to ${a(x.to)} (it moves only when ${a(x.to)} accepts).`;
        break;
      case "factory:OwnershipTransferred":
        kind = "admin change";
        text = `The factory's owner changed from ${a(x.from)} to ${a(x.to)}.`;
        break;
      case "factory:GuardianSet":
        kind = "admin change";
        text = `The factory's guardian is now ${a(x.guardian)}.`;
        break;
      case "factory:DepositsPaused":
        kind = "admin change";
        text = x.paused ? "Deposits into every group account were paused. Exits are never paused." : "Deposits into group accounts were resumed.";
        break;
      case "factory:CreationPaused":
        kind = "admin change";
        text = x.paused ? "Creating new group accounts was paused." : "Creating new group accounts was resumed.";
        break;
      case "factory:SwapFeeQueued":
        kind = "admin change";
        text = `A new swap fee of ${pct(x.bps)} was queued. It can apply after ${utc(x.eta as bigint)}.`;
        break;
      case "factory:SwapFeeSet":
        kind = "admin change";
        text = `The swap fee is now ${pct(x.bps)}.`;
        break;
      case "factory:AssetListed":
        kind = "admin change";
        text = `${await tokenName(d, x.asset)} was listed with price feed ${a(x.feed)} (age limit ${hrs(x.maxStaleness)}${x.isStock ? ", a Stock Token" : ""}).`;
        break;
      case "factory:AssetBuyable":
        kind = "admin change";
        text = `${await tokenName(d, x.asset)} can ${x.buyable ? "now" : "no longer"} be bought with /buy.`;
        break;
      case "factory:FeedQueued":
        kind = "admin change";
        text = `A new price feed ${a(x.feed)} for ${await tokenName(d, x.asset)} was queued (age limit ${hrs(x.maxStaleness)}). It can apply after ${utc(x.eta as bigint)}.`;
        break;
      case "factory:FeedApplied":
        kind = "admin change";
        text = `${await tokenName(d, x.asset)} now uses price feed ${a(x.feed)} (age limit ${hrs(x.maxStaleness)}).`;
        break;
      case "factory:AdapterQueued":
        kind = "admin change";
        text = `Swap adapter ${a(x.adapter)} was queued. It can be turned on after ${utc(x.eta as bigint)}.`;
        break;
      case "factory:AdapterSet":
        kind = "admin change";
        text = `Swap adapter ${a(x.adapter)} was ${x.allowed ? "turned on" : "turned off"}.`;
        break;
      case "fee router:PlanPaid":
        kind = "plan payment";
        text = `The fee router recorded a plan payment from group account ${a(x.pot)}: ${x.months} month(s), ${await amt(d.usdg, x.cost)}, paid until ${utc(x.paidUntil as bigint)}.`;
        break;
      case "fee router:Distributed":
        kind = "fee distribution";
        text = `The fee router sent ${await amt(x.token, x.total)} on to the four fee wallets.`;
        break;
      case "fee router:PlanPriceSet":
        kind = "admin change";
        text = `The plan price is now ${await amt(d.usdg, x.pricePerMonth)} a month.`;
        break;
      case "fee router:SinksSet":
        kind = "admin change";
        text = `The fee wallets are now ${(x.sinks as Address[]).map((s, i) => `${a(s)} (${pct((x.bps as number[])[i])})`).join(", ")}.`;
        break;
      case "fee router:FactorySet":
        kind = "admin change";
        text = `The fee router now works with factory ${a(x.factory)}.`;
        break;
      case "fee router:OwnershipTransferStarted":
        kind = "admin change";
        text = `The fee router's owner ${a(x.from)} offered ownership to ${a(x.to)} (it moves only when ${a(x.to)} accepts).`;
        break;
      case "fee router:OwnershipTransferred":
        kind = "admin change";
        text = `The fee router's owner changed from ${a(x.from)} to ${a(x.to)}.`;
        break;
      default:
        kind = "other Cofer";
        text = `${role === "group account" ? `Group account ${g}` : `The ${role}`}: ${ev.eventName}.`;
    }
    events.push({ contract: role, address: g, event: ev.eventName, logIndex: log.logIndex, text, args: plain(x) as Record<string, unknown>, kind });
  }

  const toCofer = r.to !== null && (r.to.toLowerCase() === factory || r.to.toLowerCase() === router || (await isPot(r.to)));
  const cofer = events.length > 0 || toCofer;
  const kind = events.length ? ORDER.find((k) => events.some((e) => e.kind === k))! : null;
  const failed = r.status !== "success";
  const summary = !cofer
    ? "Not a Cofer transaction: none of its logs come from a Cofer contract."
    : failed
      ? "A Cofer transaction that failed on-chain: nothing in it took effect."
      : `A Cofer ${kind}: ${(events.find((e) => e.kind === kind && e.event === "PotCreated") ?? events.find((e) => e.kind === kind)!).text}`;
  return {
    hash: r.transactionHash,
    cofer,
    status: failed ? "failed" : "succeeded",
    block: r.blockNumber,
    time,
    from: getAddress(r.from),
    to: r.to ? getAddress(r.to) : null,
    kind: failed ? null : kind,
    summary,
    events: events.map(({ kind: _k, ...e }) => e),
  };
}

async function tokenName(d: ExplainDeps, t: unknown): Promise<string> {
  const info = await d.token(a(t));
  return info ? `${info.symbol} (${a(t)})` : `token ${a(t)}`;
}
