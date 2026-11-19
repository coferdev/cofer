/** Fake data sources for the public API tests: fixed values, no network, no database. */
import { createServer } from "../src/api/server";
import { parseEnv } from "../src/env";
import type { PublicApiDeps } from "../src/publicapi/router";
import type { StatusDeps } from "../src/publicapi/status";
import type { TxDeps } from "../src/publicapi/tx";
import type { OwnershipDeps } from "../src/publicapi/ownership";
import type { PotsDeps } from "../src/publicapi/pots";
import type { MembersDeps, MemberRow } from "../src/publicapi/members";
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

export function fakePublicApi(over: Partial<PublicApiDeps> = {}): PublicApiDeps {
  return { chainId: 4663, status: fakeStatus(), tx: fakeTx(), ownership: fakeOwnership(), changelog: { text: SAMPLE_CHANGELOG, baseUrl: "https://sign.example" }, pots: fakePots(), members: fakeMembers(), ...over };
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
