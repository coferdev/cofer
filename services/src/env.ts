import { z } from "zod";
import { getAddress, parseEther } from "viem";
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
  RELAYER_MIN_ETH: z
    .string()
    .regex(/^\d+(\.\d{1,18})?$/)
    .default("0.005")
    .transform((v) => parseEther(v)), // alert when the relayer's ETH balance is below this
  EXPECTED_OWNER: addr.optional(), // the owner Safe of CoferFactory and FeeRouter; the keeper alerts if either owner differs
  EXPECTED_GUARDIAN: addr.optional(), // the factory guardian; the keeper alerts if it differs
  EXPECTED_FEE_WALLET: addr.optional(), // the wallet behind all four fee sinks; alerts call it "fee wallet"
  EXPLORER_URL: z.string().url().optional(), // block explorer override (no key); default: the known explorer for CHAIN_ID (chain/addresses.ts)
  BUNDLER_URL: z.string().url().optional(), // ZeroDev or Alchemy (member userOps from the signer site)
  PAYMASTER_URL: z.string().url().optional(),
  PASSKEY_SERVER_URL: z.string().url().optional(), // ZeroDev passkey server (signer site)
  BOT_MODE: z.enum(["webhook", "polling"]).default("webhook"),
  // read-only dashboard origin (testnet https://testdashboard.getcofer.com, mainnet https://dashboard.getcofer.com);
  // unset = no "Open dashboard" button. An https origin with no path (plain http only for localhost, for local testing)
  DASHBOARD_URL: z
    .string()
    .url()
    .refine(
      (u) => /^(https:\/\/[^/?#]+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/.test(u.replace(/\/$/, "")),
      "DASHBOARD_URL must be an https origin with no path",
    )
    .transform((u) => u.replace(/\/$/, ""))
    .optional(),

  TELEGRAM_BOT_TOKEN: z.string(),
  TELEGRAM_BOT_USERNAME: z.string(),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(16),
  LINK_SECRET: z.string().min(32),

  OPS_CHAT_ID: z.string().regex(/^-?\d+$/).transform(Number).optional(), // private chat for keeper alerts (find it with /chatid); unset = log only
  ALERT_BOT_TOKEN: z.string().min(1).optional(), // secret: a separate bot that sends alerts to OPS_CHAT_ID (unset = the main bot, via the notifier); never logged
  // team bot on the alert bot (update schedule, pinned launch board, staff commands): mainnet only, see teambot/settings.ts
  TEAMBOT_ENABLED: z
    .enum(["0", "1"])
    .default("0")
    .transform((v) => v === "1"), // "1" only on the mainnet service; anything else = off
  TEAMBOT_DATA_DIR: z.string().min(1).optional(), // private folder on the server, outside the repo: updates.json, config.json, posters/, state
  TEAMBOT_GITHUB_TOKEN: z.string().min(1).optional(), // secret: lets the team bot see and publish draft releases; never logged
  TEAMBOT_GITHUB_MODE: z.enum(["publish", "check", "off"]).default("publish"), // publish drafts at their hour | only check the release exists | skip GitHub
  TEAMBOT_TEST_CHAT_ID: z.string().regex(/^-?\d+$/).transform(Number).optional(), // a test group for "cofer-release test N"; never the staff group
  HEALTHCHECK_PING_URL: z.string().url().optional(), // secret-ish: pinged every 5 min while healthy (e.g. healthchecks.io); never logged
  STOCK_API_BASE: z.string().url().default("https://api.robinhood.com/rhj"),
  CARD_ADAPTER: z.enum(["off", "stub", "provider"]).default("off"), // stub is testnet-only (see cards/select.ts)
  CARD_STUB_FUNDING_ADDRESS: addr.optional(), // testnet stub only: where card spends go (an address you control)
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
