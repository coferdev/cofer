/** Fake data sources for the public API tests: fixed values, no network, no database. */
import { createServer } from "../src/api/server";
import { parseEnv } from "../src/env";
import type { PublicApiDeps } from "../src/publicapi/router";
import type { StatusDeps } from "../src/publicapi/status";
import type { TxDeps } from "../src/publicapi/tx";
import type { OwnershipDeps } from "../src/publicapi/ownership";
import type { PotsDeps } from "../src/publicapi/pots";
import type { KeyGroupsDeps, MembersDeps, MemberRow } from "../src/publicapi/members";
import type { BotVoteRow, OutsideEventRow, VotesDeps } from "../src/publicapi/votes";
import type { EventRow, TimelineDeps } from "../src/publicapi/timeline";
import type { ReceiptsDeps } from "../src/publicapi/receipts";
import type { VoteReceiptDeps, VoteRow } from "../src/core/voteReceipt";
import { encodeAbiParameters, encodeEventTopics, type Abi } from "viem";
import { decodeEventLog } from "viem";
import { coferPotAbi } from "../src/chain/abi";
import { encodeAction, Kind } from "../src/core/proposal";
import type { Address, Hex } from "viem";
import type { TxReceiptLike } from "../src/core/txExplain";
import recorded from "./fixtures/tx-receipts-46630.json";

export const NOW = 1_800_000_000; // unix seconds
export const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
export const TSLA = "0x322F0929c4625eD5bAd873c95208D54E1c003b2d";

export function fakeStatus(over: Partial<StatusDeps> = {}): StatusDeps {
  return {
    chainId: 4663,
    confirmations: 20,
    head: async () => 1_000_020n,
    blockTime: async (n) => NOW - Number(1_000_000n - n), // one block per second, block 1,000,000 at NOW
    cursor: async () => 1_000_000n,
    feeds: async () => [
      { symbol: "USDG", asset: USDG, answer: 100_000_000n, updatedAt: NOW - 600, maxStaleness: 86_400 },
      { symbol: "TSLA", asset: TSLA, answer: 30_000_000_000n, updatedAt: NOW - 345_000, maxStaleness: 345_600 },
    ],
    relayerHasGas: async () => true,
    now: () => NOW,
    ...over,
  };
}

/** Testnet tokens in the recorded receipts (read from the chain on 2026-11-16). */
export const TESTNET_TOKENS: Record<string, { symbol: string; decimals: number }> = {
  "0x14119629e364a53ceda500d0c1111dbb136a7398": { symbol: "USDG", decimals: 6 },
  "0x3232ddde4c6a3fe39fd17696791d50b54bc52ffe": { symbol: "TSTA", decimals: 18 },
  "0xe17565603c40583717e1d6923b8a0dda615522b9": { symbol: "TSTB", decimals: 18 },
};

/** A recorded receipt as the explainer takes it. */
export function recordedReceipt(hash: string): TxReceiptLike & { blockTime: number } {
  const r = recorded.receipts.find((x) => x.transactionHash === hash);
  if (!r) throw new Error(`no recorded receipt ${hash}`);
  return { ...r, blockNumber: BigInt(r.blockNumber), status: r.status as "success" | "reverted", from: r.from as Address, to: r.to as Address | null, transactionHash: r.transactionHash as Hex, logs: r.logs.map((l) => ({ ...l, address: l.address as Address, topics: l.topics as Hex[], data: l.data as Hex })) };
}

export function fakeTx(extra: (TxReceiptLike & { blockTime?: number })[] = [], over: Partial<TxDeps> = {}): TxDeps {
  const all = [...recorded.receipts.map((r) => recordedReceipt(r.transactionHash)), ...extra];
  const pots = new Set(recorded.pots.map((p) => p.toLowerCase()));
  return {
    receipt: async (hash) => all.find((r) => r.transactionHash.toLowerCase() === hash.toLowerCase()) ?? null,
    blockTime: async (n) => all.find((r) => r.blockNumber === n)?.blockTime ?? 0,
    explain: {
      factory: recorded.factory as Address,
      feeRouter: recorded.feeRouter as Address,
      usdg: "0x14119629e364A53ceda500d0c1111DBB136A7398",
      isPot: async (a) => pots.has(a.toLowerCase()),
      token: async (a) => TESTNET_TOKENS[a.toLowerCase()] ?? null,
    },
    ...over,
  };
}

/** Mainnet's factory and fee router as contracts/deployments/4663.json records them. */
export const MAINNET = {
  factory: "0x5d03d53A5630ceCC545Be46635779094A11E47D7" as Address,
  feeRouter: "0x3a90EC4e5107BC2e86ACC1a4d576A2daE1478527" as Address,
  owner: "0x5ACD09eAe4f160e2f2e2356e6eF0496EF6f0f064" as Address,
  guardian: "0x3f3424cdDc8Ef20EC8CDc9D104DEf1AB293E2833" as Address,
};
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

export function fakeOwnership(factoryOver: Record<string, unknown> = {}, routerOver: Record<string, unknown> = {}): OwnershipDeps {
  const f: Record<string, unknown> = { owner: MAINNET.owner, pendingOwner: ZERO_ADDR, guardian: MAINNET.guardian, depositsPaused: false, creationPaused: false, swapFeeBps: 30, pendingSwapFeeBps: 0, pendingSwapFeeEta: 0n, ...factoryOver };
  const r: Record<string, unknown> = { owner: MAINNET.owner, pendingOwner: ZERO_ADDR, ...routerOver };
  const bps = [8000, 1000, 500, 500];
  return {
    factory: MAINNET.factory,
    feeRouter: async () => MAINNET.feeRouter,
    rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
    readFactory: async (fn) => {
      if (!(fn in f)) throw new Error(`no fake for factory.${fn}`);
      return f[fn];
    },
    readRouter: async (_r, fn, args) => (fn === "sinks" ? MAINNET.guardian : fn === "bps" ? bps[Number(args![0])] : r[fn]),
  };
}

export const SAMPLE_CHANGELOG = `# Changelog

## [Unreleased]

### Tech updates
- Update 01 · 2026-12-01 14:00 UTC: Public status endpoint: Chain, latest block, indexer lag and feed ages.
- Update 02 · 2026-12-01 15:00 UTC: Status badge: Indexer live or behind, and which chain.

### Added
- Something without a date yet.

## [0.1.0] - 2026-10-31

First release. <script>not a tag</script> & more.
`;

/** One group account on testnet (addresses from the recorded receipts), with fixed chain answers. */
export const POT = "0x362B6794E6374b400aA186C1a67AC2c060af2E50" as Address;
export const POT_MEMBERS = ["0x215Ea29bE890960586CEc7e35B381F6599f955aa", "0x8251FA75f4982cDCB4bE015B9F7Ba20116a1596C", "0x6c57Cad77abE08317aB9714cF8f6CF3955775A68"] as Address[];
export const T_USDG = "0x14119629e364A53ceda500d0c1111DBB136A7398" as Address;
export const T_TSTA = "0x3232dDDE4c6a3FE39Fd17696791D50B54Bc52fFE" as Address;

export function fakePots(over: Partial<PotsDeps> = {}, reads: Record<string, unknown> = {}): PotsDeps {
  const r: Record<string, unknown> = { memberCount: 3n, threshold: 0, thresholdBps: 6000, config: [21_600, 300, 50, true], totalShares: 25n * 10n ** 18n, epoch: 2n, heldAssets: [T_USDG, T_TSTA], ...reads };
  return {
    isPot: async (a) => a.toLowerCase() === POT.toLowerCase(),
    read: async (_p, fn, args) => (fn === "distributable" ? (String(args![0]).toLowerCase() === T_USDG.toLowerCase() ? 24_000_000n : 10n ** 17n) : r[fn]),
    balanceOf: async (t) => (t.toLowerCase() === T_USDG.toLowerCase() ? 25_000_000n : 10n ** 17n),
    token: async (a) => TESTNET_TOKENS[a.toLowerCase()] ?? null,
    planPaidUntil: async () => 1_800_000_000n,
    createdBlock: async () => 147_500_000n,
    ...over,
  };
}

/** The members table for POT (one removed member) and their MemberAdded blocks. */
export const MEMBER_ROWS: MemberRow[] = [
  { address: POT_MEMBERS[0]!, active: true, shares: "10000000000000000000" },
  { address: POT_MEMBERS[1]!, active: true, shares: "15000000000000000000" },
  { address: POT_MEMBERS[2]!, active: true, shares: "0" },
  { address: "0x00000000000000000000000000000000000000d1", active: false, shares: "0" },
];

export function fakeMembers(rows: MemberRow[] = MEMBER_ROWS): MembersDeps {
  const sorted = [...rows].sort((a, b) => a.address.toLowerCase().localeCompare(b.address.toLowerCase()));
  return {
    members: async (pot, after, limit) => (pot.toLowerCase() === POT.toLowerCase() ? sorted.filter((r) => !after || r.address.toLowerCase() > after.toLowerCase()).slice(0, limit) : []),
    joinBlocks: async (_pot, ms) => new Map(ms.map((m, i) => [m.toLowerCase(), 147_500_000n + BigInt(i)])),
  };
}

const d = (n: number) => `0x${String(n).padStart(64, "0")}`;
/** The bot's votes for POT: one per state, all made with real encoded actions. */
export const BOT_VOTES: BotVoteRow[] = [
  { id: d(1), ...enc({ kind: Kind.TRANSFER, asset: T_USDG, to: POT_MEMBERS[0]!, amount: 10_000_000n }), status: "collecting", deadline: 1_800_100_000, queuedEta: null, txHash: null, createdAt: new Date("2026-12-01T10:00:00Z") },
  { id: d(2), ...enc({ kind: Kind.ADD_MEMBER, member: POT_MEMBERS[2]! }), status: "executed", deadline: 1_800_000_000, queuedEta: null, txHash: d(102), createdAt: new Date("2026-11-30T10:00:00Z") },
  { id: d(3), ...enc({ kind: Kind.SET_ALLOWANCE, member: POT_MEMBERS[1]!, amount: 5_000_000n, period: 604_800 }), status: "queued", deadline: 1_800_000_000, queuedEta: 1_799_000_000, txHash: d(103), createdAt: new Date("2026-11-29T10:00:00Z") },
  { id: d(4), ...enc({ kind: Kind.PAY_PLAN, months: 3, maxCost: 27_000_000n }), status: "expired", deadline: 1_790_000_000, queuedEta: null, txHash: null, createdAt: new Date("2026-11-28T10:00:00Z") },
  { id: d(5), ...enc({ kind: Kind.SET_THRESHOLD, threshold: 0, thresholdBps: 6000 }), status: "ready", deadline: 1_800_000_000, queuedEta: null, txHash: null, createdAt: new Date("2026-11-27T10:00:00Z") },
];
function enc(a: Parameters<typeof encodeAction>[0]) {
  const e = encodeAction(a);
  return { kind: e.kind as number, data: e.data as string };
}
/** On-chain vote logs: BOT_VOTES 2 and 3, plus one vote made outside the bot (queued, then executed). */
export const VOTE_EVENTS: OutsideEventRow[] = [
  { name: "ProposalExecuted", digest: d(2), kind: Kind.ADD_MEMBER, eta: null, txHash: d(102), block: 100n },
  { name: "ProposalQueued", digest: d(3), kind: Kind.SET_ALLOWANCE, eta: 1_799_000_000, txHash: d(103), block: 101n },
  { name: "ProposalQueued", digest: d(9), kind: Kind.TRANSFER, eta: 1_799_500_000, txHash: d(109), block: 102n },
  { name: "ProposalExecuted", digest: d(9), kind: Kind.TRANSFER, eta: null, txHash: d(110), block: 103n },
];

export function fakeVotes(over: Partial<VotesDeps> = {}): VotesDeps {
  return {
    usdg: T_USDG,
    token: async (a) => TESTNET_TOKENS[a.toLowerCase()] ?? null,
    botVotes: async (_p, statuses, limit) => BOT_VOTES.filter((v) => !statuses || statuses.includes(v.status)).slice(0, limit),
    botVoteIds: async () => new Set(BOT_VOTES.map((v) => v.id)),
    approvals: async (ids) => new Map(ids.map((id, i) => [id, i + 1])),
    voteEvents: async () => VOTE_EVENTS,
    ...over,
  };
}

/** POT's logs from the recorded testnet receipts, stored as the indexer stores them (big numbers as strings), plus one
 *  event the explainer does not describe. */
export function potEventRows(): EventRow[] {
  const rows: EventRow[] = [];
  for (const r of recorded.receipts)
    for (const l of r.logs) {
      if (l.address.toLowerCase() !== POT.toLowerCase()) continue;
      const ev = decodeEventLog({ abi: coferPotAbi, data: l.data as Hex, topics: l.topics as [Hex, ...Hex[]] });
      rows.push({ block: BigInt(r.blockNumber), logIndex: l.logIndex, txHash: r.transactionHash, name: ev.eventName, args: JSON.parse(JSON.stringify(ev.args, (_k, v) => (typeof v === "bigint" ? v.toString() : v))) });
    }
  rows.push({ block: 999_999_999n, logIndex: 0, txHash: `0x${"ee".repeat(32)}`, name: "SomethingNew", args: {} });
  return rows.sort((a, b) => (a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1));
}

export function fakeTimeline(rows: EventRow[] = potEventRows()): TimelineDeps {
  return {
    explain: { usdg: T_USDG, token: async (a) => TESTNET_TOKENS[a.toLowerCase()] ?? null },
    events: async (pot, after, limit) =>
      pot.toLowerCase() !== POT.toLowerCase() ? [] : rows.filter((r) => !after || r.block > after.block || (r.block === after.block && r.logIndex > after.logIndex)).slice(0, limit),
  };
}

/** A log built with a contract's own ABI (for event kinds no testnet transaction has emitted yet). */
export function builtLog(abi: Abi, address: Address, eventName: string, args: Record<string, unknown>, logIndex = 0) {
  const ev = abi.find((x) => x.type === "event" && x.name === eventName) as unknown as { inputs: { name: string; type: string; indexed?: boolean }[] };
  const topics = encodeEventTopics({ abi, eventName, args } as never) as Hex[];
  const data = encodeAbiParameters(ev.inputs.filter((i) => !i.indexed) as never, ev.inputs.filter((i) => !i.indexed).map((i) => args[i.name]) as never);
  return { address, topics, data, logIndex };
}

/** An exit with one token paid and one set aside, in pot 0x50F1… (block 150000000). */
export const SET_ASIDE_EXIT_TX = `0x${"5e".repeat(32)}` as Hex;
export const EXIT_POT = "0x50F19AdD1EE10AF538C1F8bE5bcbA4011F100115" as Address;
export const EXITER = "0xD6D8195a52Fa752A5bBaf76b598336FecAc9c585" as Address;
export function setAsideExit(): TxReceiptLike & { blockTime: number } {
  return {
    transactionHash: SET_ASIDE_EXIT_TX,
    blockNumber: 150_000_000n,
    blockTime: 1_790_000_000,
    status: "success",
    from: EXITER,
    to: EXIT_POT,
    logs: [
      builtLog(coferPotAbi, EXIT_POT, "ExitOwed", { asset: T_TSTA, account: EXITER, amount: 2n * 10n ** 17n }, 3),
      builtLog(coferPotAbi, EXIT_POT, "Exited", { member: EXITER, to: EXITER, shares: 5n * 10n ** 18n, assets: [T_USDG, T_TSTA], amounts: [4_500_000n, 2n * 10n ** 17n] }, 4),
    ],
  };
}

export function fakeReceipts(extra: (TxReceiptLike & { blockTime?: number })[] = []): ReceiptsDeps {
  const tx = fakeTx([setAsideExit(), ...extra]);
  return { chainId: 46630, rpcUrl: "https://rpc.testnet.chain.robinhood.com", usdg: T_USDG, isPot: tx.explain.isPot, token: tx.explain.token, receipt: tx.receipt };
}

/** A vote at the in-process EVM's test pot (0x…c0fe, chain 4663), so its digest can be compared with hashProposal. */
export const EVM_POT = "0x000000000000000000000000000000000000c0fe";
export const VOTE_ROW: VoteRow = { pot: EVM_POT, kind: Kind.TRANSFER, data: encodeAction({ kind: Kind.TRANSFER, asset: T_USDG, to: POT_MEMBERS[0]!, amount: 10_000_000n }).data, nonce: "42", epoch: 7n, deadline: 2_000_000_000, status: "collecting", txHash: null };
export const VOTE_SIGNERS = [POT_MEMBERS[0]!, POT_MEMBERS[1]!, POT_MEMBERS[2]!];

export function fakeVoteReceipts(over: Partial<VoteReceiptDeps> = {}): VoteReceiptDeps {
  return {
    chainId: 4663,
    rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
    vote: async () => VOTE_ROW,
    approvals: async () => [
      { signer: VOTE_SIGNERS[0]!, signature: "0x01", revoked: false },
      { signer: VOTE_SIGNERS[1]!, signature: "0x02", revoked: false },
      { signer: VOTE_SIGNERS[2]!, signature: "0x03", revoked: true },
    ],
    verify: async (signer) => signer === VOTE_SIGNERS[0],
    ...over,
  };
}

/** POT_MEMBERS[1] is in two groups; POT_MEMBERS[0] in one; anyone else in none. */
export function fakeKeyGroups(): KeyGroupsDeps {
  const rows: Record<string, { pot: string; shares: string }[]> = {
    [POT_MEMBERS[0]!.toLowerCase()]: [{ pot: POT, shares: "10000000000000000000" }],
    [POT_MEMBERS[1]!.toLowerCase()]: [{ pot: POT, shares: "15000000000000000000" }, { pot: "0x867851A44059BC0dB4202E78ecdC97bF55d8776e", shares: "1" }],
  };
  return {
    groupsOf: async (m) => rows[m.toLowerCase()] ?? [],
    joinBlocksIn: async (_m, pots) => new Map(pots.map((p, i) => [p.toLowerCase(), 147_600_000n + BigInt(i)])),
  };
}

export function fakePublicApi(over: Partial<PublicApiDeps> = {}): PublicApiDeps {
  return { chainId: 4663, status: fakeStatus(), tx: fakeTx(), ownership: fakeOwnership(), changelog: { text: SAMPLE_CHANGELOG, baseUrl: "https://sign.example" }, pots: fakePots(), members: fakeMembers(), keyGroups: fakeKeyGroups(), votes: fakeVotes(), timeline: fakeTimeline(), receipts: fakeReceipts(), voteReceipts: fakeVoteReceipts(), ...over };
}

/** The whole signer server with the public API on fake data (fixed, fake settings: never the process environment). */
export function publicServer(api: PublicApiDeps = fakePublicApi()) {
  const e = parseEnv({
    PUBLIC_URL: "https://sign.example",
    DATABASE_URL: "postgres://unused",
    RHC_RPC_URL: "https://rpc.example",
    FACTORY_ADDRESS: "0x0000000000000000000000000000000000000001",
    ADAPTER_ADDRESS: "0x0000000000000000000000000000000000000002",
    RELAYER_PRIVATE_KEY: "0x01",
    TELEGRAM_BOT_TOKEN: "1:unused",
    TELEGRAM_BOT_USERNAME: "unused",
    TELEGRAM_WEBHOOK_SECRET: "w".repeat(24),
    LINK_SECRET: "l".repeat(32),
    BOT_MODE: "polling",
  });
  return createServer({ deps: {} as never, cards: null, signerJs: "", env: e, publicApi: api });
}

export async function getJson(app: ReturnType<typeof publicServer>, path: string, headers: Record<string, string> = {}) {
  const r = await app.request(path, { headers });
  return { status: r.status, headers: r.headers, body: (await r.json()) as any };
}
