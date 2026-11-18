/** Fake data sources for the public API tests: fixed values, no network, no database. */
import { createServer } from "../src/api/server";
import { parseEnv } from "../src/env";
import type { PublicApiDeps } from "../src/publicapi/router";
import type { StatusDeps } from "../src/publicapi/status";

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

export function fakePublicApi(over: Partial<PublicApiDeps> = {}): PublicApiDeps {
  return { chainId: 4663, status: fakeStatus(), ...over };
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
