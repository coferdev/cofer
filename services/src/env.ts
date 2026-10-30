import { z } from "zod";
import { getAddress } from "viem";
import { RHC } from "./chain/addresses";

const hex = z.string().regex(/^0x[0-9a-fA-F]+$/);
const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

const schema = z.object({
  ROLE: z.enum(["all", "api", "bot", "indexer", "keeper", "notifier"]).default("all"),
  PORT: z.coerce.number().default(8443),
  PUBLIC_URL: z.string().url(), // signer site origin, e.g. https://sign.cofer.example
  DATABASE_URL: z.string(),
  REDIS_URL: z.string().default("redis://127.0.0.1:6379"),

  CHAIN_ID: z.coerce.number().default(4663),
  RHC_RPC_URL: z.string().url(), // Dwellir/Alchemy archive RPC (not the public RPC in prod); server only, never sent to a browser
  SIGNER_RPC_URL: z.string().url().optional(), // RPC for the signer page; sent to every browser, so never a keyed URL (default: the chain's public RPC)
  FACTORY_ADDRESS: addr,
  ADAPTER_ADDRESS: addr,
  USDG_ADDRESS: addr.default(RHC.USDG).transform((a) => getAddress(a)), // testnet pots use a mock USDG; must match factory.usdg()
  START_BLOCK: z.coerce.bigint().default(0n),
  CONFIRMATIONS: z.coerce.number().default(20), // ~2 s at 0.1 s blocks

  RELAYER_PRIVATE_KEY: hex, // pays ETH gas for permissionless execute(); holds no user funds
  BUNDLER_URL: z.string().url().optional(), // ZeroDev or Alchemy (member userOps from the signer site)
  PAYMASTER_URL: z.string().url().optional(),
  PASSKEY_SERVER_URL: z.string().url().optional(), // ZeroDev passkey server (signer site)
  BOT_MODE: z.enum(["webhook", "polling"]).default("webhook"),

  TELEGRAM_BOT_TOKEN: z.string(),
  TELEGRAM_BOT_USERNAME: z.string(),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(16),
  LINK_SECRET: z.string().min(32),

  STOCK_API_BASE: z.string().url().default("https://api.robinhood.com/rhj"),
  CARD_ADAPTER: z.enum(["stub", "provider"]).default("stub"),
  CARD_PROVIDER_URL: z.string().url().optional(),
  CARD_PROVIDER_KEY: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

export function parseEnv(src: Record<string, string | undefined>): Env {
  return schema.parse(src);
}

let cached: Env | undefined;
export function env(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}
