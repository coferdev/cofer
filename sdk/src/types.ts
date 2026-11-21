/**
 * The public API's answers as TypeScript types (big numbers arrive as decimal strings). SHAPES lists each answer's
 * top-level fields; a test in services compares them with what the API really sends, so the two cannot drift apart.
 */

export type Address = `0x${string}`;
export type Hash = `0x${string}`;
export type DecimalString = string;

export interface Meta {
  chainId: number;
  generatedAt: string;
  cacheSeconds: number;
}
export interface Answer<T> {
  data: T;
  meta: Meta;
}

export interface Status {
  chainId: number;
  headBlock: DecimalString;
  indexer: { state: "live" | "behind" | "not started"; lastBlock: DecimalString | null; targetBlock: DecimalString; lagBlocks: DecimalString | null; lagSeconds: number | null; maxLagSeconds: number };
  relayer: { hasGas: boolean | null; daysLeft: number | null };
  feeds: { symbol: string; asset: Address; state: "ok" | "near limit" | "past limit" | "bad"; ageSeconds: number; limitSeconds: number }[];
  /** SHA-256 of the signing scripts this server serves (compare with a fresh build of the release). */
  bundles: { signerJs: string; walletJs: string | null } | null;
}

export interface TxExplanation {
  hash: Hash;
  cofer: boolean;
  status: "succeeded" | "failed";
  block: DecimalString;
  time: number | null;
  from: Address;
  to: Address | null;
  kind: string | null;
  summary: string;
  events: { contract: string; address: Address; event: string; logIndex: number; text: string; args: Record<string, unknown> }[];
}

export interface Ownership {
  factory: { address: Address; owner: Address; pendingOwner: Address | null; guardian: Address; depositsPaused: boolean; creationPaused: boolean; swapFeeBps: number; queuedSwapFeeBps: number | null; queuedSwapFeeEta: number | null };
  feeRouter: { address: Address; owner: Address; pendingOwner: Address | null; sinks: { address: Address; bps: number }[] };
  exitsPausable: false;
  checks: { what: string; value: string; command: string }[];
}

export interface PotSummary {
  address: Address;
  createdBlock: DecimalString | null;
  memberCount: number;
  voteRule: { threshold: number; thresholdBps: number; approvalsNeeded: number };
  exitWindowSeconds: number;
  depositsOpen: boolean;
  maxSlipBps: number;
  entrySpreadBps: number;
  totalShares: DecimalString;
  epoch: DecimalString;
  planPaidUntil: number | null;
  assets: { asset: Address; symbol: string | null; decimals: number | null; rawBalance: DecimalString; distributable: DecimalString }[];
}

export interface MembersPage {
  members: { address: Address; active: boolean; shares: DecimalString; joinBlock: DecimalString | null }[];
  next: Address | null;
}

export interface Vote {
  id: Hash;
  kind: string;
  state: "open" | "ready" | "queued" | "executed" | "expired" | "stale" | "failed";
  summary: string;
  madeBy: "bot" | "outside the bot";
  createdAt: string | null;
  deadline: number | null;
  canRunAfter: number | null;
  approvals: number | null;
  approvalsNeeded: number;
  txHash: string | null;
}

export interface TimelinePage {
  events: { block: DecimalString; logIndex: number; txHash: Hash; event: string; kind: string; text: string; args: Record<string, unknown> }[];
  next: string | null;
}

export interface Check {
  what: string;
  command: string;
}
export interface ExitReceipt {
  kind: "exit";
  chainId: number;
  tx: Hash;
  block: DecimalString;
  pot: Address;
  member: Address;
  to: Address;
  sharesBurned: DecimalString;
  assets: { asset: Address; symbol: string | null; decimals: number | null; amount: DecimalString; sent: DecimalString; setAside: DecimalString }[];
  checks: Check[];
}
export interface DepositReceipt {
  kind: "deposit";
  chainId: number;
  tx: Hash;
  block: DecimalString;
  pot: Address;
  member: Address;
  amount: DecimalString;
  sharesMinted: DecimalString;
  groupTotalBefore: DecimalString;
  usdg: Address;
  checks: Check[];
}
export interface SpendReceipt {
  kind: "spend";
  chainId: number;
  tx: Hash;
  block: DecimalString;
  pot: Address;
  spender: Address;
  to: Address;
  amount: DecimalString;
  memo: Hash;
  allowanceLeft: DecimalString;
  usdg: Address;
  checks: Check[];
}
export interface VoteReceipt {
  kind: "vote";
  chainId: number;
  digest: Hash;
  digestMatches: boolean;
  pot: Address;
  action: string;
  state: string;
  txHash: string | null;
  signed: { domain: { name: string; version: string; chainId: number; verifyingContract: Address }; primaryType: "Proposal"; types: unknown; message: { kind: number; data: Hash; nonce: DecimalString; epoch: DecimalString; deadline: DecimalString } };
  approvals: { signer: Address; signature: Hash; withdrawn: boolean; stillValid: boolean | null }[];
  checks: Check[];
}

export interface KeyGroups {
  address: Address;
  groups: { pot: Address; shares: DecimalString; joinBlock: DecimalString | null }[];
}

export interface SetAsides {
  address: Address;
  open: { pot: Address; asset: Address; symbol: string | null; decimals: number | null; open: DecimalString; lastBlock: DecimalString; claim: { to: Address; data: Hash; function: string; note: string }; check: string }[];
}

export interface AdminChange {
  id: string;
  kind: string;
  change: string;
  canApplyAfter: number;
  canApplyAfterUtc: string;
  secondsLeft: number;
  state: string;
  queuedBlock: DecimalString;
  queuedTx: Hash;
  resolvedBlock: DecimalString | null;
  resolvedTx: Hash | null;
}
export interface AdminPending {
  pending: AdminChange[];
  recent: AdminChange[];
}

export interface Holdings {
  pot: Address;
  from: string;
  to: string;
  days: { day: string; block: DecimalString; blockTime: number; balances: { asset: Address; symbol: string | null; decimals: number | null; rawBalance: DecimalString }[] }[];
}

export interface SnapshotProof {
  pot: Address;
  block: DecimalString;
  readable: boolean;
  note?: string;
  assets: { asset: Address; symbol: string | null; decimals: number | null; rawBalance: DecimalString; reserved: DecimalString; checks: Check[] }[] | null;
  checks: Check[];
}

export interface FeesPage {
  pot: Address;
  fees: { kind: string; asset: Address; symbol: string | null; decimals: number | null; amount: DecimalString; months: number | null; block: DecimalString; logIndex: number; tx: Hash }[];
  next: string | null;
}

/** Each answer's top-level fields (checked against the live API by a test). */
export const SHAPES = {
  status: ["chainId", "headBlock", "indexer", "relayer", "feeds", "bundles"],
  tx: ["hash", "cofer", "status", "block", "time", "from", "to", "kind", "summary", "events"],
  ownership: ["factory", "feeRouter", "exitsPausable", "checks"],
  pot: ["address", "createdBlock", "memberCount", "voteRule", "exitWindowSeconds", "depositsOpen", "maxSlipBps", "entrySpreadBps", "totalShares", "epoch", "planPaidUntil", "assets"],
  members: ["members", "next"],
  votes: ["votes"],
  timeline: ["events", "next"],
  exitReceipt: ["kind", "chainId", "tx", "block", "pot", "member", "to", "sharesBurned", "assets", "checks"],
  depositReceipt: ["kind", "chainId", "tx", "block", "pot", "member", "amount", "sharesMinted", "groupTotalBefore", "usdg", "checks"],
  spendReceipt: ["kind", "chainId", "tx", "block", "pot", "spender", "to", "amount", "memo", "allowanceLeft", "usdg", "checks"],
  voteReceipt: ["kind", "chainId", "digest", "digestMatches", "pot", "action", "state", "txHash", "signed", "approvals", "checks"],
  keyGroups: ["address", "groups"],
  setAsides: ["address", "open"],
  adminPending: ["pending", "recent"],
  holdings: ["pot", "from", "to", "days"],
  snapshotProof: ["pot", "block", "readable", "assets", "checks"],
  fees: ["pot", "fees", "next"],
} as const;
