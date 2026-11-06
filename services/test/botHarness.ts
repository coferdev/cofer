/**
 * Test harness for the Telegram bot (src/bot/bot.ts). Builds the real bot with createBot(), but swaps
 * the four things it connects to for in-memory stand-ins:
 *  - settings: fixed test values (never the process environment or a .env file)
 *  - database: a small fake that answers the queries the bot makes from `state`
 *  - Redis / job queue: a fake rate counter; nothing is queued
 *  - chain: fixed pot, price and Uniswap readings from `state.chain`
 * and intercepts every Telegram call, recording it instead of sending it. Updates are fed in with
 * bot.handleUpdate(), the same entry point the webhook uses. Nothing reaches a network or a database.
 *
 * Only the functions the bot calls are replaced, and only while a bot test runs (makeBot() switches the
 * stand-ins on, releaseHarness() after each test switches them off). Bun loads every test file before
 * running any, so at all other times each replaced function hands straight through to the real one,
 * and other test files that import these modules are unaffected.
 */
import { mock } from "bun:test";
import { getAddress, HttpRequestError, zeroAddress, type Address } from "viem";
import { is, Param, SQL, StringChunk } from "drizzle-orm";
import * as realEnv from "../src/env";
import * as realDb from "../src/db/client";
import * as realQueues from "../src/queues";
import * as realClients from "../src/chain/clients";
import * as realProposals from "../src/services/proposals";

const { schema } = realDb;

// ------------------------------------------------------------------ fixed test settings

/** Test-only values. RELAYER_PRIVATE_KEY is the dummy key 0x…01, never a real key. */
export const TEST_ENV = realEnv.parseEnv({
  PUBLIC_URL: "https://sign.test",
  DATABASE_URL: "postgres://unused.test/none",
  RHC_RPC_URL: "https://rpc.test/never-called",
  FACTORY_ADDRESS: "0x0d6e43d4d7944408d9a5A10BC57B4348d61cD764",
  ADAPTER_ADDRESS: "0xFCc4Ba754Ae127396D3c6dCA507389b5A5b6EFAe",
  RELAYER_PRIVATE_KEY: `0x${"0".repeat(63)}1`,
  TELEGRAM_BOT_TOKEN: "123456:TEST-TOKEN",
  TELEGRAM_BOT_USERNAME: "cofer_test_bot",
  TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret-0123",
  LINK_SECRET: "test-link-secret-0123456789abcdef0123",
});

// ------------------------------------------------------------------ fixture addresses and people

export const USDG = TEST_ENV.USDG_ADDRESS;
export const TSLA = "0x322F0929c4625eD5bAd873c95208D54E1c003b2d" as Address;
export const POT = "0x2D3365a056074f6cd35C943EDcE644FAE7Eb8A45" as Address;
export const NEW_POT = "0x1111111111111111111111111111111111111111" as Address;
export const FEE_ROUTER = "0x1f720E7952650ED8Ca142feBD52aCBe8b7A21741" as Address;
export const POOL = "0x2222222222222222222222222222222222222222" as Address;
export const PROPOSAL_ID = `0x${"ab".repeat(32)}`;

export const ALICE = { id: 101, username: "alice_a", first_name: "Alice", address: getAddress("0x000000000000000000000000000000000000a11c") };
export const BOB = { id: 102, username: "bob_smith", first_name: "Bob", address: getAddress("0x00000000000000000000000000000000000b0b00") };
export const GROUP = { id: -1001111111111, type: "supergroup" as const, title: "Trip fund" };

// ------------------------------------------------------------------ state the fakes read from

type Row = Record<string, unknown>;
export interface Sent {
  method: string;
  payload: Record<string, unknown>;
}

function freshState() {
  const now = Math.floor(Date.now() / 1000);
  return {
    users: [] as Row[],
    pots: [] as Row[],
    members: [] as Row[],
    assets: [] as Row[],
    holdings: [] as Row[],
    alerts: [] as Row[],
    /** Telegram role per user id in the group (getChatMember). */
    roles: {} as Record<number, string>,
    /** User ids whose private chat with the bot fails (never started it). */
    dmBlocked: new Set<number>(),
    /** /newpot per-user limit: milliseconds to wait (0 = allowed). */
    rateWaitMs: 0,
    /** Every Telegram call the bot made. */
    sent: [] as Sent[],
    /** Every proposal the bot created (the action and who proposed it). */
    proposals: [] as { pot: string; action: Row; proposerTg: number }[],
    /** Every createPot transaction the relayer would have sent. */
    createPots: [] as Row[],
    chain: {
      fail: false, // every chain read throws an RPC error (with a secret-looking URL)
      held: [USDG] as Address[],
      distributable: {} as Record<string, bigint>,
      priceUpdatedAt: {} as Record<string, number>,
      nav: 1_000_000_000n, // 1,000 USDG
      shares: 500n,
      totalShares: 1_000n,
      now,
    },
  };
}
export let state = freshState();
export function resetState() {
  state = freshState();
}

// ------------------------------------------------------------------ fake database

/** The plain values inside a drizzle condition (eq / and / sql`` parts), in order. */
export function paramsOf(x: unknown, out: unknown[] = []): unknown[] {
  if (x === null || x === undefined) return out;
  if (typeof x !== "object") return out.push(x), out;
  if (is(x, Param)) return out.push((x as Param).value), out;
  if (is(x, StringChunk)) return out;
  if (is(x, SQL)) {
    for (const c of (x as SQL).queryChunks) paramsOf(c, out);
    return out;
  }
  return out; // columns and tables
}
const lc = (v: unknown) => String(v).toLowerCase();
const has = (params: unknown[], v: unknown) => params.some((p) => lc(p) === lc(v));

function findFirst(table: string, where: unknown): Row | undefined {
  const p = paramsOf(where);
  switch (table) {
    case "users":
      return state.users.find((u) => p.includes(u.tgId));
    case "pots":
      return state.pots.find((x) => p.includes(x.chatId));
    case "assets":
      // findAsset: exact lower(symbol) AND listedOnChain; /pot: by address
      return state.assets.find((a) => (p.includes(true) ? a.listedOnChain === true && p.includes(lc(a.symbol)) : has(p, a.address)));
    case "alerts":
      return state.alerts.find((a) => p.includes(a.key));
    default:
      return undefined;
  }
}

function runSelect(from: unknown, join: unknown, p: unknown[]): Row[] {
  if (from === schema.members && join === schema.users) {
    // resolveMember: this pot's active members with a key, exact lower(username)
    const [pot, , handle] = p;
    return state.members
      .filter((m) => lc(m.pot) === lc(pot) && m.active !== false)
      .flatMap((m) => state.users.filter((u) => u.address && lc(u.address) === lc(m.address) && u.username && lc(u.username) === lc(handle)))
      .map((u) => ({ username: u.username, address: u.address }));
  }
  if (from === schema.members && join === schema.pots) {
    // exitPotsOf: pots where this key is an active member
    const [addr] = p;
    return state.members
      .filter((m) => lc(m.address) === lc(addr) && m.active !== false)
      .flatMap((m) => state.pots.filter((x) => lc(x.address) === lc(m.pot)))
      .map((x) => ({ address: x.address, title: x.title }));
  }
  if (from === schema.members && join === undefined) {
    // isActiveMember (/pot dashboard button): this pot, this key, still active
    const [pot, addr] = p;
    return state.members.filter((m) => lc(m.pot) === lc(pot) && lc(m.address) === lc(addr) && m.active !== false).map((m) => ({ a: m.address }));
  }
  if (from === schema.holdings) return state.holdings.filter((h) => has(p, h.pot));
  return [];
}

function selectBuilder() {
  let from: unknown;
  let join: unknown;
  const b = {
    from: (t: unknown) => ((from = t), b),
    innerJoin: (t: unknown) => ((join = t), b),
    where: (cond: unknown) => Promise.resolve(runSelect(from, join, paramsOf(cond))),
  };
  return b;
}

function insertInto(table: unknown) {
  return {
    values(v: Row) {
      if (table === schema.users) {
        const u = state.users.find((x) => x.tgId === v.tgId);
        if (u) Object.assign(u, { username: v.username });
        else state.users.push({ address: null, region: null, ...v });
      } else if (table === schema.pots) state.pots.push(v);
      const done = Promise.resolve([] as Row[]);
      return Object.assign(done, { onConflictDoUpdate: () => done, onConflictDoNothing: () => done });
    },
  };
}

function updateTable(table: unknown) {
  return {
    set: (v: Row) => ({
      where: async (cond: unknown) => {
        const p = paramsOf(cond);
        if (table === schema.users) for (const u of state.users) if (p.includes(u.tgId)) Object.assign(u, v);
      },
    }),
  };
}

export const fakeDb = {
  query: {
    users: { findFirst: async (q: { where: unknown }) => findFirst("users", q.where) },
    pots: { findFirst: async (q: { where: unknown }) => findFirst("pots", q.where) },
    assets: { findFirst: async (q: { where: unknown }) => findFirst("assets", q.where) },
    alerts: { findFirst: async (q: { where: unknown }) => findFirst("alerts", q.where) },
  },
  select: () => selectBuilder(),
  insert: (t: unknown) => insertInto(t),
  update: (t: unknown) => updateTable(t),
};

// ------------------------------------------------------------------ fake chain

const rpcError = () => new HttpRequestError({ url: "https://rpc.test/SECRET-KEY-123", details: "fetch failed" });

/** Oracle price: 1 TSLA = 250 USDG. USDG has 6 decimals, TSLA 18. */
function oracle(tokenIn: string, tokenOut: string, amount: bigint): bigint {
  if (lc(tokenIn) === lc(tokenOut)) return amount;
  return lc(tokenIn) === lc(USDG) ? (amount * 10n ** 12n) / 250n : (amount * 250n) / 10n ** 12n;
}

export const fakePublicClient = {
  async readContract(a: { address: string; functionName: string; args?: readonly unknown[] }) {
    if (state.chain.fail) throw rpcError();
    const c = state.chain;
    const arg0 = a.args?.[0] as string;
    switch (a.functionName) {
      case "heldAssets":
        return c.held;
      case "MAX_DEPOSIT_PRICE_AGE":
        return 43_200;
      case "distributable":
        return c.distributable[lc(arg0)] ?? 0n;
      case "priceUpdatedAt":
        return BigInt(c.priceUpdatedAt[lc(arg0)] ?? c.now);
      case "navUsdg":
        return [c.nav, 0n];
      case "memberInfo":
        return { active: true, shares: c.shares, allowance: 0n, period: 0, periodStart: 0n, spent: 0n };
      case "totalShares":
        return c.totalShares;
      case "swapFeeBps":
        return 30;
      case "config":
        return [21_600, 300, 50, true];
      case "quote":
        return oracle(arg0, a.args![1] as string, a.args![2] as bigint);
      case "feeRouter":
        return FEE_ROUTER;
      case "planPricePerMonth":
        return 9_000_000n;
      case "getPool":
        return a.args![2] === 3000 ? POOL : zeroAddress; // one Uniswap pool, at the 0.3% tier
      case "liquidity":
        return 10n ** 24n;
      default:
        throw new Error(`fake chain: no reading for ${a.functionName}`);
    }
  },
  async simulateContract(a: { functionName: string; args: readonly unknown[] }) {
    if (state.chain.fail) throw rpcError();
    if (a.functionName === "createPot") return { request: { functionName: "createPot", args: a.args }, result: NEW_POT };
    if (a.functionName === "quoteExactInput") {
      // the pool pays 99.5% of the oracle price
      const path = a.args[0] as string;
      const tokenIn = `0x${path.slice(2, 42)}`;
      const tokenOut = `0x${path.slice(-40)}`;
      return { result: [(oracle(tokenIn, tokenOut, a.args[1] as bigint) * 995n) / 1000n, [], [], 0n] };
    }
    throw new Error(`fake chain: cannot simulate ${a.functionName}`);
  },
  async getBlock() {
    return { timestamp: BigInt(state.chain.now) };
  },
  async waitForTransactionReceipt() {
    return { status: "success" };
  },
};

export const fakeRelayer = {
  account: { address: "0x000000000000000000000000000000000000BEEF" },
  async writeContract(request: Row) {
    state.createPots.push(request);
    return `0x${"12".repeat(32)}`;
  },
};

// ------------------------------------------------------------------ module swaps (before the bot is loaded)

/** The real functions, kept before the swap: used whenever no bot test is running. */
const real = {
  env: realEnv.env,
  db: realDb.db,
  redis: realQueues.redis,
  enqueueRelay: realQueues.enqueueRelay,
  enqueueNotify: realQueues.enqueueNotify,
  publicClient: realClients.publicClient,
  relayerClient: realClients.relayerClient,
  createProposal: realProposals.createProposal,
  getSignable: realProposals.getSignable,
};
let active = false;
/** Switches the stand-ins off again (call after each bot test). */
export function releaseHarness() {
  active = false;
}
type AnyFn = (...a: never[]) => unknown;
/** The stand-in while a bot test runs, otherwise the real function. */
const swap = <F extends AnyFn>(realFn: F, fake: (...a: Parameters<F>) => unknown) => ((...a: Parameters<F>) => (active ? fake(...a) : realFn(...a))) as unknown as F;

mock.module("../src/env", () => ({ ...realEnv, env: swap(real.env, () => TEST_ENV) }));
mock.module("../src/db/client", () => ({ ...realDb, db: swap(real.db, () => fakeDb) }));
mock.module("../src/queues", () => ({
  ...realQueues,
  redis: swap(real.redis, () => ({ eval: async () => state.rateWaitMs })),
  enqueueRelay: swap(real.enqueueRelay, async () => {}),
  enqueueNotify: swap(real.enqueueNotify, async () => {}),
}));
mock.module("../src/chain/clients", () => ({
  ...realClients,
  publicClient: swap(real.publicClient, () => fakePublicClient),
  relayerClient: swap(real.relayerClient, () => fakeRelayer),
}));
mock.module("../src/services/proposals", () => ({
  ...realProposals,
  createProposal: swap(real.createProposal, async (_deps: unknown, args: { pot: string; action: Row; proposerTg: number }) => {
    state.proposals.push(args);
    return { id: PROPOSAL_ID, summary: `summary of kind ${String(args.action.kind)}` };
  }),
  getSignable: swap(real.getSignable, async () => ({ summary: "Send 50 USDG to @bob_smith", status: "collecting", tally: { approvals: 1, required: 2 } })),
}));

// ------------------------------------------------------------------ the bot, with Telegram intercepted

let nextMessageId = 1000;
function telegramResult(method: string, p: Record<string, unknown>): { ok: boolean; result?: unknown; error_code?: number; description?: string } {
  if (method === "sendMessage") {
    const chatId = Number(p.chat_id);
    if (chatId > 0 && state.dmBlocked.has(chatId)) return { ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" };
    const eph = p.ephemeral_message_parameters as { receiver_user_id?: number } | undefined;
    // an ephemeral reply comes back with message_id 0 and its receiver (privateReply checks this)
    const message_id = eph ? 0 : nextMessageId++;
    return { ok: true, result: { message_id, date: state.chain.now, chat: { id: chatId, type: chatId > 0 ? "private" : "supergroup" }, text: p.text, ...(eph ? { receiver_user: { id: eph.receiver_user_id, is_bot: false, first_name: "x" } } : {}) } };
  }
  if (method === "getChatMember") return { ok: true, result: { status: state.roles[Number(p.user_id)] ?? "member", user: { id: Number(p.user_id), is_bot: false, first_name: "x" } } };
  return { ok: true, result: true }; // answerCallbackQuery, deleteMessage, ...
}

export async function makeBot(opts: { cardsOn?: boolean } = {}) {
  active = true;
  const { createBot } = await import("../src/bot/bot");
  const bot = createBot({ cardsOn: opts.cardsOn ?? false });
  bot.botInfo = {
    id: 999,
    is_bot: true,
    first_name: "Cofer",
    username: TEST_ENV.TELEGRAM_BOT_USERNAME,
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
  } as never;
  // installed last, so it runs first and nothing goes out
  bot.api.config.use(async (_prev, method, payload) => {
    const p = { ...(payload as Record<string, unknown>) };
    state.sent.push({ method, payload: p });
    return telegramResult(method, p) as never;
  });
  return bot;
}

// ------------------------------------------------------------------ updates, as Telegram delivers them

let updateId = 1;
type Person = { id: number; username?: string; first_name: string };
type Chat = { id: number; type: "private" | "group" | "supergroup"; title?: string };

export function privateChat(p: Person): Chat {
  return { id: p.id, type: "private" };
}

/** A command message. `senderChat` set = sent on behalf of a chat (anonymous admin, linked channel). */
export function command(text: string, from: Person, chat: Chat = GROUP, senderChat?: Chat) {
  const cmd = text.split(/\s/)[0]!;
  return {
    update_id: updateId++,
    message: {
      message_id: nextMessageId++,
      date: state.chain.now,
      chat,
      from: { id: from.id, is_bot: false, first_name: from.first_name, username: from.username },
      ...(senderChat ? { sender_chat: senderChat } : {}),
      text,
      entities: [{ type: "bot_command", offset: 0, length: cmd.length }],
    },
  };
}

/** A tap on an inline button of a message in `chat`. */
export function tap(data: string, from: Person, chat: Chat = GROUP) {
  return {
    update_id: updateId++,
    callback_query: {
      id: `cb${updateId}`,
      from: { id: from.id, is_bot: false, first_name: from.first_name, username: from.username },
      chat_instance: "ci",
      data,
      message: { message_id: nextMessageId++, date: state.chain.now, chat, text: "vote card" },
    },
  };
}

// ------------------------------------------------------------------ fixtures

export function linkedUser(p: typeof ALICE) {
  state.users.push({ tgId: p.id, username: p.username, address: p.address, region: null });
}
export function groupPot(memberAddresses: Address[] = [ALICE.address]) {
  state.pots.push({ address: POT, chatId: GROUP.id, title: GROUP.title });
  for (const a of memberAddresses) state.members.push({ pot: POT, address: a, active: true });
}
export function listedTsla(extra: Row = {}) {
  state.assets.push({
    address: TSLA,
    symbol: "TSLA",
    decimals: 18,
    isStock: true,
    listedOnChain: true,
    currentMultiplier: "1000000000000000000",
    pendingMultiplier: null,
    pendingEffectiveAt: null,
    status: "active",
    ...extra,
  });
}

/** Messages the bot sent (sendMessage only). */
export function messages() {
  return state.sent.filter((s) => s.method === "sendMessage").map((s) => s.payload);
}
export function lastMessage() {
  const m = messages();
  return m[m.length - 1];
}
/** Every url in a message's inline keyboard. */
export function urls(m: Record<string, unknown> | undefined): string[] {
  const kb = (m?.reply_markup as { inline_keyboard?: { url?: string }[][] } | undefined)?.inline_keyboard ?? [];
  return kb.flat().map((b) => b.url!).filter(Boolean);
}
