/**
 * Read-only dashboard view of one pot, for one member. Pure: it takes rows already read (indexer
 * tables and live prices) and returns what the dashboard shows. Every amount stays a bigint in raw
 * token units and leaves as a decimal string with its token's decimals; JavaScript numbers are only
 * used for counts, basis points and times. Nothing here reaches the database or the chain.
 */
import { getAddress, type Address } from "viem";
import { requiredVotes } from "../core/votes";
import { allowanceLeft, memberValue, nextResetAt } from "../core/shares";
import { shownQuantity } from "../core/valuation";

export type ProposalStatus = "collecting" | "ready" | "queued" | "executed" | "expired" | "stale" | "failed";

export interface PotRow {
  address: string;
  title: string;
  threshold: number;
  thresholdBps: number;
  guardDelay: number;
  depositsOpen: boolean;
  totalShares: string;
  planPaidUntil: Date | null;
}

export interface MemberRow {
  address: string;
  shares: string;
  allowance: string;
  period: number;
  username: string | null;
}

export interface ProposalRow {
  id: string;
  kind: number;
  summary: string;
  status: ProposalStatus;
  queuedEta: number | null;
  txHash: string | null;
  createdAt: Date;
}

export interface SignatureRow {
  proposalId: string;
  signer: string;
  revoked: boolean;
}

export interface AssetMeta {
  symbol: string;
  decimals: number;
  isStock: boolean;
  multiplier: string | null; // the issuer's 18-dp multiplier string (display quantity only)
}

/** A holding with its live price. value/unitPrice are USDG base units, or null while the price is paused. */
export interface PricedHoldingRow {
  asset: string;
  rawBalance: string;
  reserved: string;
  updatedAt: Date;
  valueUsdg: bigint | null;
  unitPriceUsdg: bigint | null;
}

export interface EventRow {
  txHash: string;
  logIndex: number;
  block: bigint;
  name: string;
  args: Record<string, unknown>;
  at: Date;
}

/** The caller's own allowance, read live from the pot (memberInfo), or null when it could not be read. */
export interface LiveAllowance {
  allowance: bigint;
  period: number;
  periodStart: number;
  spent: bigint;
}

export interface IndexerState {
  block: bigint | null;
  behind: boolean;
}

export const USDG_DECIMALS = 6;
export const MAX_PROPOSALS = 50;
export const MAX_ACTIVITY = 50;

/** Pending (still moving), confirmed (done on chain) or failed (will not happen). */
export type ProposalState = "pending" | "confirmed" | "failed";

/** Fixed text for each stored status. The stored error text is never sent: it can hold internal detail. */
export function proposalState(status: ProposalStatus, queuedEta: number | null, now: number): { state: ProposalState; text: string } {
  switch (status) {
    case "collecting":
      return { state: "pending", text: "Collecting approvals" };
    case "ready":
      return { state: "pending", text: "Approved, being submitted" };
    case "queued":
      return queuedEta !== null && now >= queuedEta
        ? { state: "pending", text: "Exit window over, being executed" }
        : { state: "pending", text: "Approved, in the exit window" };
    case "executed":
      return { state: "confirmed", text: "Executed" };
    case "expired":
      return { state: "failed", text: "Expired before enough approvals" };
    case "stale":
      return { state: "failed", text: "Cancelled by a group change" };
    case "failed":
      return { state: "failed", text: "The transaction failed" };
  }
}

/**
 * Approvals that count: one per current member, revoked votes left out, case of the address
 * ignored. A duplicate row for the same signer (two taps at once) counts once.
 */
export function countApprovals(signatures: SignatureRow[], members: string[]): Set<string> {
  const current = new Set(members.map((m) => m.toLowerCase()));
  const counted = new Set<string>();
  for (const s of signatures) {
    const k = s.signer.toLowerCase();
    if (!s.revoked && current.has(k)) counted.add(k);
  }
  return counted;
}

/** a / b in basis points, rounded down; 0 when b is 0. */
export function bps(a: bigint, b: bigint): number {
  return b === 0n ? 0 : Number((a * 10_000n) / b);
}

const str = (v: unknown): string | null => (typeof v === "string" || typeof v === "number" || typeof v === "bigint" ? String(v) : null);
const addrOrNull = (v: unknown): Address | null => {
  const s = str(v);
  try {
    return s ? getAddress(s) : null;
  } catch {
    return null;
  }
};

export type ActivityItem = {
  id: string;
  type: string;
  at: string; // ISO time the indexer saw it
  block: string;
  txHash: string;
  member?: Address | null;
  to?: Address | null;
  asset?: Address | null;
  assetIn?: Address | null;
  assetOut?: Address | null;
  amount?: string | null; // raw units of `asset` (USDG for deposits and allowance spends)
  amountIn?: string | null;
  amountOut?: string | null;
  months?: string | null;
};

/** One activity line per pot event, newest first. Unknown events are left out, never guessed at. */
export function activityFrom(events: EventRow[], usdg: Address): ActivityItem[] {
  const out: ActivityItem[] = [];
  const sorted = [...events].sort((a, b) => (a.block === b.block ? b.logIndex - a.logIndex : a.block < b.block ? 1 : -1));
  for (const e of sorted) {
    const base = { id: `${e.txHash}:${e.logIndex}`, at: e.at.toISOString(), block: e.block.toString(), txHash: e.txHash };
    const a = e.args;
    switch (e.name) {
      case "Initialized":
        out.push({ ...base, type: "created" });
        break;
      case "Deposited":
        out.push({ ...base, type: "deposit", member: addrOrNull(a.member), asset: usdg, amount: str(a.amount) });
        break;
      case "Exited":
        out.push({ ...base, type: "exit", member: addrOrNull(a.member) });
        break;
      case "AllowanceSpent":
        out.push({ ...base, type: "spend", member: addrOrNull(a.member), to: addrOrNull(a.to), asset: usdg, amount: str(a.amount) });
        break;
      case "Transferred":
        out.push({ ...base, type: "transfer", asset: addrOrNull(a.asset), to: addrOrNull(a.to), amount: str(a.amount) });
        break;
      case "Swapped":
        out.push({ ...base, type: "swap", assetIn: addrOrNull(a.tokenIn), assetOut: addrOrNull(a.tokenOut), amountIn: str(a.amountIn), amountOut: str(a.amountOut) });
        break;
      case "MemberAdded":
        out.push({ ...base, type: "member-added", member: addrOrNull(a.member) });
        break;
      case "MemberRemoved":
        out.push({ ...base, type: "member-removed", member: addrOrNull(a.member) });
        break;
      case "ProposalExecuted":
        out.push({ ...base, type: "executed" });
        break;
      case "ProposalQueued":
        out.push({ ...base, type: "queued" });
        break;
      case "ThresholdSet":
        out.push({ ...base, type: "threshold" });
        break;
      case "ConfigSet":
        out.push({ ...base, type: "config" });
        break;
      case "AllowanceSet":
        out.push({ ...base, type: "allowance", member: addrOrNull(a.member), asset: usdg, amount: str(a.amount) });
        break;
      case "PlanPaid":
        out.push({ ...base, type: "plan", asset: usdg, amount: str(a.cost), months: str(a.months) });
        break;
      case "ExitOwed":
        out.push({ ...base, type: "owed", member: addrOrNull(a.account), asset: addrOrNull(a.asset), amount: str(a.amount) });
        break;
      case "OwedClaimed":
        out.push({ ...base, type: "claimed", member: addrOrNull(a.account), asset: addrOrNull(a.asset), amount: str(a.amount) });
        break;
    }
    if (out.length >= MAX_ACTIVITY) break;
  }
  return out;
}

export interface PotViewInput {
  chainId: number;
  usdg: Address;
  me: Address;
  now: number; // unix seconds
  pot: PotRow;
  members: MemberRow[]; // active members only
  proposals: ProposalRow[];
  signatures: SignatureRow[];
  holdings: PricedHoldingRow[];
  assets: Map<string, AssetMeta>; // lower-case address -> meta
  events: EventRow[];
  myAllowance: LiveAllowance | null;
  indexer: IndexerState;
}

const metaOf = (assets: Map<string, AssetMeta>, a: string, usdg: Address): AssetMeta =>
  assets.get(a.toLowerCase()) ?? (a.toLowerCase() === usdg.toLowerCase() ? { symbol: "USDG", decimals: USDG_DECIMALS, isStock: false, multiplier: null } : { symbol: "?", decimals: 18, isStock: false, multiplier: null });

/** Builds the dashboard view of one pot. The caller must already be an active member (checked by the route). */
export function potView(i: PotViewInput) {
  const memberAddrs = i.members.map((m) => getAddress(m.address));
  const totalShares = BigInt(i.pot.totalShares);
  const required = requiredVotes({ members: memberAddrs, threshold: i.pot.threshold, thresholdBps: i.pot.thresholdBps });

  // holdings: available = raw balance minus what is set aside for members who exited
  let total = 0n;
  let anyPaused = false;
  const priced: bigint[] = [];
  const holdings = i.holdings.map((h) => {
    const meta = metaOf(i.assets, h.asset, i.usdg);
    const available = BigInt(h.rawBalance) - BigInt(h.reserved);
    if (h.valueUsdg === null) anyPaused = true;
    else {
      total += h.valueUsdg;
      priced.push(h.valueUsdg);
    }
    return {
      asset: getAddress(h.asset),
      symbol: meta.symbol,
      decimals: meta.decimals,
      isStock: meta.isStock,
      available: available.toString(),
      shownQuantity: shownQuantity(available < 0n ? 0n : available, meta.decimals, meta.isStock ? meta.multiplier : null),
      valueUsdg: h.valueUsdg === null ? null : h.valueUsdg.toString(),
      unitPriceUsdg: h.unitPriceUsdg === null ? null : h.unitPriceUsdg.toString(),
      pricePaused: h.valueUsdg === null,
      balanceAsOf: h.updatedAt.toISOString(),
    };
  });

  const meLower = i.me.toLowerCase();
  const meRow = i.members.find((m) => m.address.toLowerCase() === meLower);
  const myShares = meRow ? BigInt(meRow.shares) : 0n;
  // the member's value: their share of each priced holding, each rounded down (as the contract rounds exits)
  const myValue = memberValue(myShares, totalShares, priced);
  const nothingPriced = anyPaused && priced.length === 0;

  const members = i.members.map((m) => ({
    address: getAddress(m.address),
    you: m.address.toLowerCase() === meLower,
    username: m.username,
    shares: m.shares,
    shareBps: bps(BigInt(m.shares), totalShares),
    allowance: m.allowance,
    period: m.period,
  }));

  const sigsBy = new Map<string, SignatureRow[]>();
  for (const s of i.signatures) {
    const list = sigsBy.get(s.proposalId) ?? [];
    list.push(s);
    sigsBy.set(s.proposalId, list);
  }
  const proposals = [...i.proposals]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, MAX_PROPOSALS)
    .map((p) => {
      const counted = countApprovals(sigsBy.get(p.id) ?? [], memberAddrs);
      const st = proposalState(p.status, p.queuedEta, i.now);
      return {
        id: p.id,
        kind: p.kind,
        summary: p.summary,
        status: p.status,
        state: st.state,
        stateText: st.text,
        approvals: counted.size,
        required,
        signedByYou: counted.has(meLower),
        executeAfter: p.status === "queued" && p.queuedEta !== null ? new Date(p.queuedEta * 1000).toISOString() : null,
        txHash: p.txHash,
        createdAt: p.createdAt.toISOString(),
      };
    });

  const a = i.myAllowance;
  const you = {
    address: getAddress(i.me),
    shares: myShares.toString(),
    shareBps: bps(myShares, totalShares),
    valueUsdg: nothingPriced ? null : myValue.toString(),
    allowance: a ? a.allowance.toString() : meRow?.allowance ?? "0",
    allowanceLeft: a ? allowanceLeft(a, i.now).toString() : null,
    period: a ? a.period : meRow?.period ?? 0,
    nextResetAt: a && nextResetAt(a, i.now) !== null ? new Date(nextResetAt(a, i.now)! * 1000).toISOString() : null,
  };

  const activity = activityFrom(i.events, i.usdg);
  // symbols and decimals for the assets this pot holds or its activity names (public listing data only)
  const used = new Set<string>([i.usdg.toLowerCase(), ...i.holdings.map((h) => h.asset.toLowerCase())]);
  for (const x of activity) for (const k of [x.asset, x.assetIn, x.assetOut]) if (k) used.add(k.toLowerCase());

  return {
    address: getAddress(i.pot.address),
    title: i.pot.title,
    chainId: i.chainId,
    usdg: { address: i.usdg, symbol: "USDG", decimals: USDG_DECIMALS },
    value: {
      // null only when nothing at all could be priced; partial when some prices are paused
      totalUsdg: nothingPriced ? null : total.toString(),
      partial: anyPaused,
    },
    you,
    members,
    rules: {
      membersCount: members.length,
      approvalsRequired: Number.isFinite(required) ? required : null,
      threshold: i.pot.threshold,
      thresholdBps: i.pot.thresholdBps,
      exitWindowSec: i.pot.guardDelay,
      depositsOpen: i.pot.depositsOpen,
      planPaidUntil: i.pot.planPaidUntil ? i.pot.planPaidUntil.toISOString() : null,
    },
    holdings,
    proposals,
    activity,
    assets: Object.fromEntries(
      [...used].map((k) => {
        const m = metaOf(i.assets, k, i.usdg);
        return [getAddress(k), { symbol: m.symbol, decimals: m.decimals }];
      }),
    ),
    indexer: { block: i.indexer.block === null ? null : i.indexer.block.toString(), behind: i.indexer.behind },
    asOf: new Date(i.now * 1000).toISOString(),
  };
}

export type PotView = ReturnType<typeof potView>;

/** One line per pot in the member's own list. */
export function potSummary(p: { address: string; title: string; members: number; totalUsdg: bigint | null; partial: boolean }) {
  return { address: getAddress(p.address), title: p.title, members: p.members, totalUsdg: p.totalUsdg === null ? null : p.totalUsdg.toString(), partial: p.partial };
}
