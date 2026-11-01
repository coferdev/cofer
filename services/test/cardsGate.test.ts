import { describe, expect, test } from "bun:test";
import { TRPCError } from "@trpc/server";
import { getAddress } from "viem";
import { parseEnv } from "../src/env";
import { cardsAvailable, selectCardAdapter, TESTNET_CHAIN_ID } from "../src/cards/select";
import { StubCardAdapter } from "../src/cards/StubCardAdapter";
import { CARDS_OFF_TEXT, helpText } from "../src/bot/help";
import { appRouter, type ApiCtx } from "../src/api/router";
import type { CardAdapter } from "../src/cards/CardAdapter";

const MAINNET = 4663;
const FUNDING = "0x00000000000000000000000000000000000000f1";

const REQUIRED_ENV = {
  PUBLIC_URL: "https://sign.example",
  DATABASE_URL: "postgres://x",
  RHC_RPC_URL: "https://rpc.example",
  FACTORY_ADDRESS: "0x0000000000000000000000000000000000000001",
  ADAPTER_ADDRESS: "0x0000000000000000000000000000000000000002",
  RELAYER_PRIVATE_KEY: "0x01",
  TELEGRAM_BOT_TOKEN: "x",
  TELEGRAM_BOT_USERNAME: "x",
  TELEGRAM_WEBHOOK_SECRET: "x".repeat(16),
  LINK_SECRET: "x".repeat(32),
};

describe("card adapter selection (H-1)", () => {
  test("cards are off by default, also on mainnet", () => {
    const e = parseEnv(REQUIRED_ENV);
    expect(e.CHAIN_ID).toBe(MAINNET);
    expect(e.CARD_ADAPTER).toBe("off");
    expect(selectCardAdapter(e)).toBeNull();
    expect(cardsAvailable(e)).toBe(false);
  });

  test("the stub is refused on mainnet, even with a funding address", () => {
    expect(() => selectCardAdapter({ CHAIN_ID: MAINNET, CARD_ADAPTER: "stub", CARD_STUB_FUNDING_ADDRESS: FUNDING })).toThrow("testnet");
  });

  test("the stub on testnet needs an explicit, non-burn funding address", () => {
    expect(() => selectCardAdapter({ CHAIN_ID: TESTNET_CHAIN_ID, CARD_ADAPTER: "stub" })).toThrow("CARD_STUB_FUNDING_ADDRESS");
    for (const burn of ["0x000000000000000000000000000000000000dEaD", "0x0000000000000000000000000000000000000000"]) {
      expect(() => selectCardAdapter({ CHAIN_ID: TESTNET_CHAIN_ID, CARD_ADAPTER: "stub", CARD_STUB_FUNDING_ADDRESS: burn })).toThrow("burn");
    }
    const a = selectCardAdapter({ CHAIN_ID: TESTNET_CHAIN_ID, CARD_ADAPTER: "stub", CARD_STUB_FUNDING_ADDRESS: FUNDING });
    expect(a).toBeInstanceOf(StubCardAdapter);
  });

  test("the testnet stub quotes the configured address, not a burn address", async () => {
    const a = selectCardAdapter({ CHAIN_ID: TESTNET_CHAIN_ID, CARD_ADAPTER: "stub", CARD_STUB_FUNDING_ADDRESS: FUNDING })!;
    const q = (await a.quote({ pot: getAddress("0x00000000000000000000000000000000000000aa"), member: getAddress("0x00000000000000000000000000000000000000bb"), amountUsdg: 100_000_000n }))!;
    expect(q.fundingAddress).toBe(getAddress(FUNDING));
  });

  test("the provider setting still stops start-up until it exists", () => {
    expect(() => selectCardAdapter({ CHAIN_ID: MAINNET, CARD_ADAPTER: "provider" })).toThrow("out of band");
  });
});

describe("/card in the bot (H-1)", () => {
  test("/help lists /card only when cards are on", () => {
    expect(helpText({ cardsOn: false })).not.toContain("/card");
    expect(helpText({ cardsOn: true })).toContain("/card");
    expect(CARDS_OFF_TEXT).toBe("Cards are not available yet.");
  });
});

// ---------------------------------------------------------------- card API

const secret = "s".repeat(40);
const ME = { tgId: 7, address: "0x00000000000000000000000000000000000000a1" };
const OTHER = { tgId: 8, address: "0x00000000000000000000000000000000000000b2" };
const ORDER = { id: "order-1", member: ME.address };

function session(tg: number) {
  return { tg, chat: -100, p: "session" as const, ref: "", exp: Math.floor(Date.now() / 1000) + 600, jti: `j${tg}` };
}

function caller(tg: number, cards: CardAdapter | null) {
  const writes: unknown[] = [];
  const users = [ME, OTHER];
  const db = {
    query: {
      users: { findFirst: async () => users.find((u) => u.tgId === tg) },
      cardOrders: { findFirst: async () => ORDER },
    },
    update: () => ({ set: (v: unknown) => ({ where: async () => void writes.push(v) }) }),
    insert: () => ({ values: async (v: unknown) => void writes.push(v) }),
  };
  // the session is passed in directly, as server.ts does after verifyLink
  const ctx: ApiCtx = { deps: { db } as unknown as ApiCtx["deps"], cards, secret, session: session(tg) };
  return { api: appRouter.createCaller(ctx), writes };
}

const okCards = (): CardAdapter & { confirmed: string[] } => {
  const confirmed: string[] = [];
  return {
    name: "test",
    confirmed,
    quote: async () => null,
    confirm: async (a) => {
      confirmed.push(a.orderId);
      return { orderId: a.orderId, status: "funded" };
    },
    status: async (id) => ({ orderId: id, status: "funded" }),
  };
};

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof TRPCError ? e.code : String(e);
  }
}

describe("card API (H-1, I-2)", () => {
  test("both card routes refuse when cards are off", async () => {
    const { api, writes } = caller(ME.tgId, null);
    expect(await code(api.card.quote({ pot: "0x00000000000000000000000000000000000000aa", amountUsdg: "100000000" }))).toBe("PRECONDITION_FAILED");
    expect(await code(api.card.confirm({ orderId: ORDER.id, spendTx: "0x01" }))).toBe("PRECONDITION_FAILED");
    expect(writes).toHaveLength(0);
  });

  test("a member cannot confirm someone else's card order", async () => {
    const cards = okCards();
    const { api, writes } = caller(OTHER.tgId, cards);
    expect(await code(api.card.confirm({ orderId: ORDER.id, spendTx: "0x01" }))).toBe("NOT_FOUND");
    expect(cards.confirmed).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  test("the member who asked for the quote can confirm it", async () => {
    const cards = okCards();
    const { api, writes } = caller(ME.tgId, cards);
    expect(await code(api.card.confirm({ orderId: ORDER.id, spendTx: "0x01" }))).toBe("ok");
    expect(cards.confirmed).toEqual([ORDER.id]);
    expect(writes).toHaveLength(1);
  });
});
