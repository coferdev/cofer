/** Fake data sources for the public API tests: fixed values, no network, no database. */
import { createServer } from "../src/api/server";
import { parseEnv } from "../src/env";
import type { PublicApiDeps } from "../src/publicapi/router";
import type { StatusDeps } from "../src/publicapi/status";
import type { TxDeps } from "../src/publicapi/tx";
import type { OwnershipDeps } from "../src/publicapi/ownership";
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

export function fakePublicApi(over: Partial<PublicApiDeps> = {}): PublicApiDeps {
  return { chainId: 4663, status: fakeStatus(), tx: fakeTx(), ownership: fakeOwnership(), ...over };
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
