import { describe, expect, test } from "bun:test";
import { TRPCError } from "@trpc/server";
import { Bot } from "grammy";
import { appRouter, type ApiCtx } from "../src/api/router";
import { signLink, type LinkClaims } from "../src/core/linkToken";
import { createServer } from "../src/api/server";
import { parseEnv } from "../src/env";

const secret = "s".repeat(40);
const POT = "0x00000000000000000000000000000000000000aa";
const ADDR = "0x00000000000000000000000000000000000000bb";
const ID = `0x${"ab".repeat(32)}`;
const exp = () => Math.floor(Date.now() / 1000) + 600;

/** No database: these calls must be refused before any resolver runs. */
function caller(session: LinkClaims | null) {
  const ctx: ApiCtx = { deps: {} as ApiCtx["deps"], cards: null, secret, session };
  return appRouter.createCaller(ctx);
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof TRPCError ? e.code : `not a TRPCError: ${String(e)}`;
  }
}

type Api = ReturnType<typeof caller>;

/** Every signed-in route, with a valid-looking input. */
const ROUTES: [string, (api: Api) => Promise<unknown>][] = [
  ["me.get", (api) => api.me.get()],
  ["me.link", (api) => api.me.link({ address: ADDR, signature: "0x01", kind: "eoa" })],
  ["me.linkMessage", (api) => api.me.linkMessage()],
  ["me.setRegion", (api) => api.me.setRegion({ region: "FR" })],
  ["pot.get", (api) => api.pot.get({ pot: POT })],
  ["pot.previewExit", (api) => api.pot.previewExit({ pot: POT, shares: "1" })],
  ["proposal.create", (api) => api.proposal.create({ pot: POT, action: { kind: 2, member: ADDR } })],
  ["proposal.get", (api) => api.proposal.get({ id: ID })],
  ["proposal.sign", (api) => api.proposal.sign({ id: ID, signer: ADDR, signature: "0x01" })],
  ["card.quote", (api) => api.card.quote({ pot: POT, amountUsdg: "100000000" })],
  ["card.confirm", (api) => api.card.confirm({ orderId: "o1", spendTx: "0x01" })],
];

describe("every signed-in API route refuses callers without a session", () => {
  test("the list covers every signed-in route of the router", () => {
    const all = Object.keys((appRouter as unknown as { _def: { procedures: Record<string, unknown> } })._def.procedures);
    const publicRoutes = ["session.preview", "session.exchange"];
    expect(all.filter((r) => !publicRoutes.includes(r)).sort()).toEqual(ROUTES.map(([n]) => n).sort());
  });

  for (const [name, call] of ROUTES) {
    test(`${name}: no session -> UNAUTHORIZED`, async () => {
      expect(await code(call(caller(null)))).toBe("UNAUTHORIZED");
    });

    test(`${name}: a one-time link instead of a session -> UNAUTHORIZED`, async () => {
      const linkClaims: LinkClaims = { tg: 7, chat: 7, p: "deposit", ref: POT, exp: exp(), jti: "j" };
      expect(await code(call(caller(linkClaims)))).toBe("UNAUTHORIZED");
    });
  }
});

describe("signed-in routes refuse malformed input before doing anything", () => {
  const session: LinkClaims = { tg: 7, chat: 7, p: "session", ref: "", exp: exp(), jti: "s" };
  const api = caller(session);
  const BAD: [string, () => Promise<unknown>][] = [
    ["me.link: short address", () => api.me.link({ address: "0x1234", signature: "0x01", kind: "eoa" })],
    ["me.link: unknown key kind", () => api.me.link({ address: ADDR, signature: "0x01", kind: "other" as never })],
    ["me.link: signature not hex", () => api.me.link({ address: ADDR, signature: "nothex", kind: "eoa" })],
    ["me.setRegion: not two letters", () => api.me.setRegion({ region: "USA" })],
    ["me.setRegion: digits", () => api.me.setRegion({ region: "12" })],
    ["pot.get: not an address", () => api.pot.get({ pot: "nope" })],
    ["pot.previewExit: not an address", () => api.pot.previewExit({ pot: "nope", shares: "1" })],
    ["proposal.create: swaps are built by the bot only", () => api.proposal.create({ pot: POT, action: { kind: 1 } as never })],
    ["proposal.create: unknown kind", () => api.proposal.create({ pot: POT, action: { kind: 99 } as never })],
    ["proposal.create: transfer to a bad address", () => api.proposal.create({ pot: POT, action: { kind: 0, asset: ADDR, to: "0x12", amount: "1" } })],
    ["proposal.get: id not hex", () => api.proposal.get({ id: "0xZZ" })],
    ["proposal.sign: signer not an address", () => api.proposal.sign({ id: ID, signer: "bob", signature: "0x01" })],
    ["card.quote: pot not an address", () => api.card.quote({ pot: "x", amountUsdg: "1" })],
    ["card.confirm: spend tx not hex", () => api.card.confirm({ orderId: "o1", spendTx: "xyz" })],
  ];
  for (const [name, call] of BAD) {
    test(`${name} -> BAD_REQUEST`, async () => {
      expect(await code(call())).toBe("BAD_REQUEST");
    });
  }

  test("public routes refuse a forged or malformed link", async () => {
    const forged = signLink({ tg: 7, chat: 7, p: "deposit", ref: "", exp: exp(), jti: "f" }, "y".repeat(40));
    expect(await code(caller(null).session.preview({ token: forged }))).toBe("UNAUTHORIZED");
    expect(await code(caller(null).session.exchange({ token: forged }))).toBe("UNAUTHORIZED");
    expect(await code(caller(null).session.preview({ token: "garbage" }))).toBe("UNAUTHORIZED");
  });
});

describe("the Telegram webhook refuses requests without the shared secret", () => {
  const WEBHOOK_SECRET = "w".repeat(24);

  function app() {
    // fixed, fake settings: never the process environment or a local .env; nothing reaches a network or a database
    const e = parseEnv({
      PUBLIC_URL: "https://sign.example",
      DATABASE_URL: "postgres://unused",
      RHC_RPC_URL: "https://rpc.example",
      FACTORY_ADDRESS: "0x0000000000000000000000000000000000000001",
      ADAPTER_ADDRESS: "0x0000000000000000000000000000000000000002",
      RELAYER_PRIVATE_KEY: "0x01",
      TELEGRAM_BOT_TOKEN: "1:unused",
      TELEGRAM_BOT_USERNAME: "unused",
      TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
      LINK_SECRET: "l".repeat(32),
      BOT_MODE: "webhook",
    });
    const bot = new Bot("1:unused", { botInfo: { id: 1, is_bot: true, first_name: "t", username: "t", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as never });
    return { app: createServer({ deps: {} as never, cards: null, bot, signerJs: "", env: e }), secretHeader: WEBHOOK_SECRET };
  }

  const update = JSON.stringify({ update_id: 1 });

  test("no secret header -> 401, wrong secret -> 401", async () => {
    const { app: a } = app();
    expect((await a.request("/tg/webhook", { method: "POST", body: update, headers: { "content-type": "application/json" } })).status).toBe(401);
    const wrong = await a.request("/tg/webhook", { method: "POST", body: update, headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "nope" } });
    expect(wrong.status).toBe(401);
  });

  test("control: the right secret is accepted", async () => {
    const { app: a, secretHeader } = app();
    const ok = await a.request("/tg/webhook", { method: "POST", body: update, headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secretHeader } });
    expect(ok.status).toBe(200);
  });
});
