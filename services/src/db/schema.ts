import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const proposalStatus = pgEnum("proposal_status", [
  "collecting", // gathering signatures
  "ready", // threshold met, not yet submitted
  "queued", // on-chain, waiting guard delay (exit window)
  "executed",
  "expired",
  "stale", // epoch bumped before execution
  "failed",
]);

/** One row per group pot (a Telegram group may have one active pot). */
export const pots = pgTable(
  "pots",
  {
    address: text("address").primaryKey(), // checksummed
    chatId: bigint("chat_id", { mode: "number" }).notNull(),
    title: text("title").notNull(),
    creatorTg: bigint("creator_tg", { mode: "number" }).notNull(),
    epoch: bigint("epoch", { mode: "bigint" }).notNull().default(sql`0`),
    threshold: smallint("threshold").notNull(),
    thresholdBps: integer("threshold_bps").notNull(),
    guardDelay: integer("guard_delay").notNull(),
    maxSlipBps: integer("max_slip_bps").notNull(),
    entrySpreadBps: integer("entry_spread_bps").notNull(),
    depositsOpen: boolean("deposits_open").notNull().default(true),
    totalShares: numeric("total_shares", { precision: 78, scale: 0 }).notNull().default("0"),
    planPaidUntil: timestamp("plan_paid_until", { withTimezone: true }),
    createdBlock: bigint("created_block", { mode: "bigint" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("pots_chat_idx").on(t.chatId)],
);

/** Telegram user <-> member key binding (proved by a signed message from the key). */
export const users = pgTable("users", {
  tgId: bigint("tg_id", { mode: "number" }).primaryKey(),
  username: text("username"),
  address: text("address").unique(), // member smart account (Kernel + passkey) or EOA
  accountKind: text("account_kind"), // "kernel-passkey" | "safe-webauthn" | "eoa"
  region: text("region"), // self-declared ISO-3166 alpha-2
  linkedAt: timestamp("linked_at", { withTimezone: true }),
});

export const members = pgTable(
  "members",
  {
    pot: text("pot").notNull().references(() => pots.address),
    address: text("address").notNull(),
    active: boolean("active").notNull().default(true),
    shares: numeric("shares", { precision: 78, scale: 0 }).notNull().default("0"),
    allowance: numeric("allowance", { precision: 78, scale: 0 }).notNull().default("0"),
    period: integer("period").notNull().default(0),
    periodStart: bigint("period_start", { mode: "number" }).notNull().default(0),
    spent: numeric("spent", { precision: 78, scale: 0 }).notNull().default("0"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.pot, t.address] })],
);

export const proposals = pgTable(
  "proposals",
  {
    id: text("id").primaryKey(), // digest (0x...)
    pot: text("pot").notNull().references(() => pots.address),
    kind: smallint("kind").notNull(),
    data: text("data").notNull(),
    nonce: numeric("nonce", { precision: 78, scale: 0 }).notNull(),
    epoch: bigint("epoch", { mode: "bigint" }).notNull(),
    deadline: bigint("deadline", { mode: "number" }).notNull(),
    summary: text("summary").notNull(), // rendered from decoded calldata
    proposerTg: bigint("proposer_tg", { mode: "number" }).notNull(),
    status: proposalStatus("status").notNull().default("collecting"),
    chatMessageId: integer("chat_message_id"),
    queuedEta: bigint("queued_eta", { mode: "number" }),
    txHash: text("tx_hash"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("proposals_pot_status_idx").on(t.pot, t.status)],
);

export const signatures = pgTable(
  "signatures",
  {
    proposalId: text("proposal_id").notNull().references(() => proposals.id),
    signer: text("signer").notNull(),
    signature: text("signature").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull().defaultNow(),
    revoked: boolean("revoked").notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.proposalId, t.signer] })],
);

/** Raw decoded chain events (append-only, idempotent on tx+log index). */
export const chainEvents = pgTable(
  "chain_events",
  {
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    block: bigint("block", { mode: "bigint" }).notNull(),
    address: text("address").notNull(),
    name: text("name").notNull(),
    args: jsonb("args").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.txHash, t.logIndex] }), index("chain_events_addr_idx").on(t.address, t.block)],
);

export const holdings = pgTable(
  "holdings",
  {
    pot: text("pot").notNull().references(() => pots.address),
    asset: text("asset").notNull(),
    rawBalance: numeric("raw_balance", { precision: 78, scale: 0 }).notNull(),
    reserved: numeric("reserved", { precision: 78, scale: 0 }).notNull().default("0"),
    valueUsdg: numeric("value_usdg", { precision: 78, scale: 0 }), // null when feed stale
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.pot, t.asset] })],
);

/** Canonical Stock Tokens (from the issuer's public asset API) + other listed assets. */
export const assets = pgTable("assets", {
  address: text("address").primaryKey(),
  symbol: text("symbol").notNull(),
  decimals: smallint("decimals").notNull(),
  isStock: boolean("is_stock").notNull().default(false),
  feed: text("feed"),
  currentMultiplier: text("current_multiplier"), // 18-dp decimal string from the API
  pendingMultiplier: text("pending_multiplier"),
  pendingEffectiveAt: timestamp("pending_effective_at", { withTimezone: true }),
  listedOnChain: boolean("listed_on_chain").notNull().default(false),
  status: text("status"),
  refreshedAt: timestamp("refreshed_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cursors = pgTable("cursors", {
  name: text("name").primaryKey(),
  block: bigint("block", { mode: "bigint" }).notNull(),
});

export const linkTokens = pgTable("link_tokens", {
  jti: text("jti").primaryKey(),
  tgId: bigint("tg_id", { mode: "number" }).notNull(),
  purpose: text("purpose").notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const cardOrders = pgTable("card_orders", {
  id: text("id").primaryKey(),
  pot: text("pot").notNull(),
  member: text("member").notNull(),
  amountUsdg: numeric("amount_usdg", { precision: 78, scale: 0 }).notNull(),
  provider: text("provider").notNull(),
  providerRef: text("provider_ref"),
  fundingAddress: text("funding_address"),
  spendTx: text("spend_tx"),
  status: text("status").notNull(), // quoted | funded | issued | failed | refunded
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Keeper alerts that are open now (one row per problem); a row is removed when the problem clears. */
export const alerts = pgTable("alerts", {
  key: text("key").primaryKey(), // e.g. "feed-stale:0x…"
  text: text("text").notNull(),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Last trusted feed reading per Stock Token, for the multiplier continuity check (keeper). */
export const feedReadings = pgTable("feed_readings", {
  asset: text("asset").primaryKey(),
  answer: numeric("answer", { precision: 78, scale: 0 }).notNull(), // feed answer, raw
  feedUpdatedAt: bigint("feed_updated_at", { mode: "number" }).notNull(), // feed's own time, unix seconds
  multiplier: numeric("multiplier", { precision: 78, scale: 0 }).notNull(), // token uiMultiplier(), 1e18 = 1
  mismatchSince: bigint("mismatch_since", { mode: "number" }), // unix seconds; set while feed and multiplier disagree
  seenAt: timestamp("seen_at", { withTimezone: true }).notNull().defaultNow(),
});
