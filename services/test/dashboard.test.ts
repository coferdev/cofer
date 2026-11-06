/**
 * Read-only dashboard API (src/dashboard/): sign-in, authorization, replayed and duplicate links,
 * concurrent approvals, decimals, indexer lag, failed transactions, backend down and recovery.
 * Nothing here reaches a database, a chain or a network: the data source is an in-memory stand-in.
 */
import { describe, expect, test } from "bun:test";
import { TRPCError } from "@trpc/server";
import { getAddress, type Address } from "viem";
import { appRouter, type ApiCtx } from "../src/api/router";
import { createServer } from "../src/api/server";
import { signLink, verifyLink, type LinkClaims, type LinkPurpose } from "../src/core/linkToken";
import { parseEnv } from "../src/env";
import { DASHBOARD_SESSION_TTL_SEC, TEXT, dashboardRoutes, type DashboardDeps, type PotListItem } from "../src/dashboard/routes";
import { activityFrom, countApprovals, MAX_ACTIVITY, potView, proposalState, type PotViewInput, type ProposalStatus } from "../src/dashboard/view";
import { PRICE_CACHE_MS, priceReader } from "../src/dashboard/data";
import { linkTokenOf } from "../src/bot/keyboards";

const secret = "d".repeat(40);
const USDG = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
const TSLA = getAddress("0x322F0929c4625eD5bAd873c95208D54E1c003b2d");
const POT = getAddress("0x2D3365a056074f6cd35C943EDcE644FAE7Eb8A45");
const OTHER_POT = getAddress("0x1111111111111111111111111111111111111111");
const ALICE = { tg: 101, key: getAddress("0x000000000000000000000000000000000000a11c") };
const BOB = { tg: 102, key: getAddress("0x00000000000000000000000000000000000b0b00") };
const CAROL = getAddress("0x00000000000000000000000000000000000c0c00");
const NOW = 1_800_000_000;

const claims = (c: Partial<LinkClaims>): LinkClaims => ({ tg: ALICE.tg, chat: ALICE.tg, p: "dashboard", ref: "", exp: NOW + 600, jti: `j-${Math.random()}`, ...c });
const token = (c: Partial<LinkClaims>) => signLink(claims(c), secret);
const dashSession = (c: Partial<LinkClaims> = {}) => token({ p: "dash", exp: NOW + 1800, ...c });

function baseInput(over: Partial<PotViewInput> = {}): PotViewInput {
  return {
    chainId: 46630,
    usdg: USDG,
    me: ALICE.key,
    now: NOW,
    pot: { address: POT, title: "Trip fund", threshold: 2, thresholdBps: 6000, guardDelay: 21600, depositsOpen: true, totalShares: "3000", planPaidUntil: null },
    members: [
      { address: ALICE.key, shares: "1000", allowance: "50000000", period: 604800, username: "alice_a" },
      { address: BOB.key, shares: "2000", allowance: "0", period: 0, username: null },
    ],
    proposals: [],
    signatures: [],
    holdings: [],
    assets: new Map([[TSLA.toLowerCase(), { symbol: "TSLA", decimals: 18, isStock: true, multiplier: "1.0" }]]),
    events: [],
    myAllowance: null,
    indexer: { block: 123n, behind: false },
    deposit: { stalePrice: null, nav: 0n },
    owed: [],
    ...over,
  };
}

/** An in-memory data source. Only ALICE's key is a member of POT; OTHER_POT exists but she is not in it. */
function fakeDeps(over: Partial<DashboardDeps> = {}) {
  const used = new Set<string>();
  const calls = { spend: 0, potsOf: [] as Address[], potInput: [] as [Address, Address][] };
  const keys = new Map<number, Address>([
    [ALICE.tg, ALICE.key],
    [BOB.tg, BOB.key],
  ]);
  const membership = new Map<string, Address[]>([
    [POT.toLowerCase(), [ALICE.key]],
    [OTHER_POT.toLowerCase(), [BOB.key]],
  ]);
  const deps: DashboardDeps = {
    secret,
    chainId: 46630,
    signerUrl: "https://sign.test",
    now: () => NOW,
    async spendLink(l) {
      calls.spend++;
      await new Promise((r) => setTimeout(r, 1)); // let two requests interleave
      if (used.has(l.jti)) return false;
      used.add(l.jti);
      return true;
    },
    async keyOf(tg) {
      return keys.get(tg) ?? null;
    },
    async potsOf(member) {
      calls.potsOf.push(member);
      const out: PotListItem[] = [];
      for (const [pot, ms] of membership) if (ms.some((m) => m === member)) out.push({ address: getAddress(pot), title: "Trip fund", members: ms.length, totalUsdg: 1_500_000_000n, partial: false });
      return out;
    },
    async potInput(pot, member) {
      calls.potInput.push([pot, member]);
      if (!(membership.get(pot.toLowerCase()) ?? []).includes(member)) return null;
      return baseInput({ me: member });
    },
    ...over,
  };
  return { deps, calls };
}

function app(deps: DashboardDeps) {
  return dashboardRoutes(deps);
}
const get = (a: ReturnType<typeof app>, path: string, session?: string) =>
  a.request(`http://x${path}`, { headers: session ? { authorization: `Bearer ${session}` } : {} });
const post = (a: ReturnType<typeof app>, body: unknown) =>
  a.request("http://x/session", { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

// ---------------------------------------------------------------- sign-in

describe("sign-in: a one-time dashboard link becomes a short read-only session", () => {
  test("a valid link -> a 'dash' session for the same Telegram user, 30 minutes", async () => {
    const { deps } = fakeDeps();
    const r = await post(app(deps), { token: token({}) });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { session: string; expiresAt: string };
    const s = verifyLink(body.session, secret, NOW);
    expect([s.p, s.tg, s.chat, s.ref]).toEqual(["dash", ALICE.tg, ALICE.tg, ""]);
    expect(s.exp).toBe(NOW + DASHBOARD_SESSION_TTL_SEC);
    expect(body.expiresAt).toBe(new Date((NOW + DASHBOARD_SESSION_TTL_SEC) * 1000).toISOString());
  });

  test("replayed link: the second use is refused", async () => {
    const { deps } = fakeDeps();
    const a = app(deps);
    const t = token({});
    expect((await post(a, { token: t })).status).toBe(200);
    const again = await post(a, { token: t });
    expect(again.status).toBe(401);
    expect(await again.json()).toEqual({ error: TEXT.link });
  });

  test("duplicate requests at the same moment: exactly one session", async () => {
    const { deps } = fakeDeps();
    const a = app(deps);
    const t = token({});
    const results = await Promise.all(Array.from({ length: 5 }, () => post(a, { token: t })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 401, 401, 401, 401]);
  });

  for (const p of ["onboard", "sign", "deposit", "exit", "claim", "card", "session", "dash"] as LinkPurpose[]) {
    test(`a '${p}' link is not a dashboard link: refused, and not spent`, async () => {
      const { deps, calls } = fakeDeps();
      expect((await post(app(deps), { token: token({ p }) })).status).toBe(401);
      expect(calls.spend).toBe(0);
    });
  }

  test("a dashboard link made for a group chat (not the member's private chat) is refused", async () => {
    const { deps, calls } = fakeDeps();
    expect((await post(app(deps), { token: token({ chat: -100123 }) })).status).toBe(401);
    expect(calls.spend).toBe(0);
  });

  test("expired, forged or malformed links are refused", async () => {
    const { deps } = fakeDeps();
    const a = app(deps);
    expect((await post(a, { token: token({ exp: NOW - 1 }) })).status).toBe(401);
    expect((await post(a, { token: signLink(claims({}), "x".repeat(40)) })).status).toBe(401);
    expect((await post(a, { token: "not.a.token" })).status).toBe(401);
    expect((await post(a, { token: 5 })).status).toBe(400);
    expect((await post(a, "{not json")).status).toBe(400);
    expect((await post(a, { token: "a".repeat(5000) })).status).toBe(400);
  });
});

// ---------------------------------------------------------------- authorization

describe("authorization: only a dashboard session, only the member's own pots", () => {
  const paths = ["/pots", `/pots/${POT}`];

  for (const path of paths) {
    test(`${path}: no session -> 401`, async () => {
      const { deps } = fakeDeps();
      const r = await get(app(deps), path);
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ error: TEXT.session });
    });

    test(`${path}: a signer session, the one-time link itself, an expired or forged session -> 401`, async () => {
      const { deps } = fakeDeps();
      const a = app(deps);
      for (const s of [token({ p: "session" }), token({ p: "dashboard" }), dashSession({ exp: NOW - 1 }), signLink(claims({ p: "dash" }), "x".repeat(40))]) {
        expect((await get(a, path, s)).status).toBe(401);
      }
    });
  }

  test("/pots lists only the caller's own pots, looked up from the caller's own key", async () => {
    const { deps, calls } = fakeDeps();
    const r = await get(app(deps), "/pots", dashSession());
    const body = (await r.json()) as { chainId: number; linked: boolean; pots: { address: string; totalUsdg: string }[] };
    expect(body.chainId).toBe(46630);
    expect(body.linked).toBe(true);
    expect(body.pots.map((p) => p.address)).toEqual([POT]);
    expect(body.pots[0]!.totalUsdg).toBe("1500000000");
    expect(calls.potsOf).toEqual([ALICE.key]);
  });

  test("a pot the caller is not in gets the same 404 as one that does not exist", async () => {
    const { deps } = fakeDeps();
    const a = app(deps);
    const notMine = await get(a, `/pots/${OTHER_POT}`, dashSession());
    const missing = await get(a, `/pots/0x${"9".repeat(40)}`, dashSession());
    expect(notMine.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await notMine.text()).toBe(await missing.text());
  });

  test("the member is always the caller's own key, whatever the request says", async () => {
    const { deps, calls } = fakeDeps();
    await get(app(deps), `/pots/${POT.toLowerCase()}?member=${BOB.key}`, dashSession());
    expect(calls.potInput).toEqual([[POT, ALICE.key]]);
  });

  test("no key bound yet: an empty list, and no pot", async () => {
    const { deps } = fakeDeps();
    const a = app(deps);
    const s = dashSession({ tg: 999, chat: 999 });
    expect(await (await get(a, "/pots", s)).json()).toEqual({ chainId: 46630, linked: false, pots: [] });
    expect((await get(a, `/pots/${POT}`, s)).status).toBe(404);
  });

  test("a malformed pot address -> 404; there are no write routes", async () => {
    const { deps, calls } = fakeDeps();
    const a = app(deps);
    expect((await get(a, "/pots/nope", dashSession())).status).toBe(404);
    for (const m of ["POST", "PUT", "DELETE"]) {
      const r = await a.request(`http://x/pots/${POT}`, { method: m, headers: { authorization: `Bearer ${dashSession()}` } });
      expect(r.status).toBe(404);
    }
    expect(calls.potInput).toEqual([]);
  });

  test("every answer says not to cache it", async () => {
    const { deps } = fakeDeps();
    const a = app(deps);
    for (const r of [await get(a, "/pots", dashSession()), await get(a, "/pots"), await post(a, { token: token({}) })]) {
      expect(r.headers.get("cache-control")).toBe("no-store");
    }
  });
});

describe("the signer API and the dashboard never accept each other's links", () => {
  function signerCaller(session: LinkClaims | null) {
    // no database: a refused call must never reach it
    const deps = new Proxy({}, { get: () => { throw new Error("must not be reached"); } });
    return appRouter.createCaller({ deps, cards: null, secret, session } as unknown as ApiCtx);
  }
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
      return "ok";
    } catch (e) {
      return e instanceof TRPCError ? e.code : String(e);
    }
  };

  for (const p of ["dashboard", "dash"] as LinkPurpose[]) {
    test(`session.exchange and session.preview refuse a '${p}' link`, async () => {
      const api = signerCaller(null);
      expect(await code(api.session.exchange({ token: token({ p, exp: Math.floor(Date.now() / 1000) + 600 }) }))).toBe("UNAUTHORIZED");
      expect(await code(api.session.preview({ token: token({ p, exp: Math.floor(Date.now() / 1000) + 600 }) }))).toBe("UNAUTHORIZED");
    });
  }

  test("a dashboard session cannot use any signer route", async () => {
    const api = signerCaller(claims({ p: "dash", exp: Math.floor(Date.now() / 1000) + 600 }));
    expect(await code(api.me.get())).toBe("UNAUTHORIZED");
    expect(await code(api.proposal.create({ pot: POT, action: { kind: 2, member: BOB.key } }))).toBe("UNAUTHORIZED");
    expect(await code(api.proposal.sign({ id: `0x${"ab".repeat(32)}`, signer: ALICE.key, signature: "0x01" }))).toBe("UNAUTHORIZED");
  });
});

// ---------------------------------------------------------------- backend down and recovery

describe("backend down and recovery", () => {
  test("a failed read -> 503 with fixed text (no URL); the next read works again", async () => {
    let down = true;
    const { deps } = fakeDeps();
    const potInput = deps.potInput;
    deps.potInput = async (...a) => {
      if (down) throw new Error("connect ECONNREFUSED https://rpc.example/SECRET-KEY");
      return potInput(...a);
    };
    const a = app(deps);
    const r1 = await get(a, `/pots/${POT}`, dashSession());
    expect(r1.status).toBe(503);
    const body = await r1.text();
    expect(body).not.toMatch(/https?:|SECRET|ECONNREFUSED/);
    expect(JSON.parse(body)).toEqual({ error: TEXT.down });
    down = false;
    expect((await get(a, `/pots/${POT}`, dashSession())).status).toBe(200);
  });

  test("a database failure while spending a link -> 503, and the link still works afterwards", async () => {
    let down = true;
    const { deps } = fakeDeps();
    const spend = deps.spendLink;
    deps.spendLink = async (l) => {
      if (down) throw new Error("db down");
      return spend(l);
    };
    const a = app(deps);
    const t = token({});
    expect((await post(a, { token: t })).status).toBe(503);
    down = false;
    expect((await post(a, { token: t })).status).toBe(200);
  });
});

describe("the server mounts the dashboard API only when it is given one", () => {
  const e = parseEnv({
    PUBLIC_URL: "https://sign.test",
    DATABASE_URL: "postgres://unused.test/none",
    RHC_RPC_URL: "https://rpc.test/never-called",
    FACTORY_ADDRESS: "0x0d6e43d4d7944408d9a5A10BC57B4348d61cD764",
    ADAPTER_ADDRESS: "0xFCc4Ba754Ae127396D3c6dCA507389b5A5b6EFAe",
    RELAYER_PRIVATE_KEY: `0x${"0".repeat(63)}1`,
    TELEGRAM_BOT_TOKEN: "123456:TEST-TOKEN",
    TELEGRAM_BOT_USERNAME: "cofer_test_bot",
    TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret-0123",
    LINK_SECRET: secret,
  });
  test("with it: /api/dashboard/pots answers; without it: 404", async () => {
    const { deps } = fakeDeps();
    const on = createServer({ deps: {} as never, cards: null, signerJs: "", env: e, dashboard: deps });
    const off = createServer({ deps: {} as never, cards: null, signerJs: "", env: e });
    const h = { authorization: `Bearer ${dashSession()}` };
    expect((await on.request("http://x/api/dashboard/pots", { headers: h })).status).toBe(200);
    expect((await off.request("http://x/api/dashboard/pots", { headers: h })).status).toBe(404);
  });
});

// ---------------------------------------------------------------- the view: decimals, approvals, states

describe("decimals: exact integer amounts, never JavaScript numbers", () => {
  test("USDG (6 dp) and a Stock Token (18 dp): exact strings, total = sum of the parts", () => {
    const v = potView(
      baseInput({
        holdings: [
          { asset: USDG, rawBalance: "9007199254740993", reserved: "0", updatedAt: new Date(NOW * 1000), valueUsdg: 9007199254740993n, unitPriceUsdg: 1_000_000n },
          { asset: TSLA, rawBalance: "1234567890123456789", reserved: "234567890123456789", updatedAt: new Date(NOW * 1000), valueUsdg: 250_123_456n, unitPriceUsdg: 250_123_456n },
        ],
      }),
    );
    expect(v.value.totalUsdg).toBe((9007199254740993n + 250_123_456n).toString()); // past 2^53: a number would round it
    expect(v.value.partial).toBe(false);
    const tsla = v.holdings.find((h) => h.symbol === "TSLA")!;
    expect(tsla.available).toBe("1000000000000000000"); // reserved for exited members is not the pot's
    expect(tsla.decimals).toBe(18);
    expect(tsla.shownQuantity).toBe("1");
    expect(v.holdings.find((h) => h.symbol === "USDG")!.shownQuantity).toBe("9007199254.740993");
  });

  test("the member's value is their share of each priced holding, each rounded down", () => {
    const v = potView(
      baseInput({
        holdings: [
          { asset: USDG, rawBalance: "100", reserved: "0", updatedAt: new Date(), valueUsdg: 100n, unitPriceUsdg: 1_000_000n },
          { asset: TSLA, rawBalance: "1", reserved: "0", updatedAt: new Date(), valueUsdg: 200n, unitPriceUsdg: 200n },
        ],
      }),
    );
    // 1000 of 3000 shares: floor(100/3) + floor(200/3) = 33 + 66 = 99 (not floor(300/3) = 100)
    expect(v.you.valueUsdg).toBe("99");
    expect(v.you.shareBps).toBe(3333);
    expect(v.members.map((m) => m.shareBps)).toEqual([3333, 6666]);
  });

  test("a split shows the issuer's quantity; value still comes from the feed", () => {
    const assets = new Map([[TSLA.toLowerCase(), { symbol: "TSLA", decimals: 18, isStock: true, multiplier: "2.0" }]]);
    const v = potView(baseInput({ assets, holdings: [{ asset: TSLA, rawBalance: "1500000000000000000", reserved: "0", updatedAt: new Date(), valueUsdg: 7n, unitPriceUsdg: 5n }] }));
    expect(v.holdings[0]!.shownQuantity).toBe("3");
    expect(v.holdings[0]!.valueUsdg).toBe("7");
  });

  test("a paused price: the total is marked partial; nothing priced at all -> no total", () => {
    const usdg = { asset: USDG, rawBalance: "5", reserved: "0", updatedAt: new Date(), valueUsdg: 5n, unitPriceUsdg: 1_000_000n };
    const paused = { asset: TSLA, rawBalance: "1", reserved: "0", updatedAt: new Date(), valueUsdg: null, unitPriceUsdg: null };
    const some = potView(baseInput({ holdings: [usdg, paused] }));
    expect([some.value.totalUsdg, some.value.partial, some.holdings[1]!.pricePaused]).toEqual(["5", true, true]);
    const none = potView(baseInput({ holdings: [paused] }));
    expect([none.value.totalUsdg, none.you.valueUsdg]).toEqual([null, null]);
    const empty = potView(baseInput({ holdings: [] }));
    expect([empty.value.totalUsdg, empty.value.partial]).toEqual(["0", false]);
  });

  test("the caller's allowance left is computed from the pot's live reading, in USDG units", () => {
    const v = potView(baseInput({ myAllowance: { allowance: 50_000_000n, period: 604800, periodStart: NOW - 100, spent: 12_345_678n } }));
    expect(v.you.allowanceLeft).toBe("37654322");
    expect(v.you.nextResetAt).toBe(new Date((NOW - 100 + 604800) * 1000).toISOString());
    // unreadable: shown from the indexer, without "left"
    expect(potView(baseInput()).you.allowanceLeft).toBeNull();
  });
});

describe("concurrent approvals: each current member counts once", () => {
  const P = `0x${"ab".repeat(32)}`;
  const prop = (status: ProposalStatus = "collecting") => ({ id: P, kind: 0, summary: "Send 10 USDG", status, queuedEta: null, deadline: NOW + 86400, txHash: null, createdAt: new Date(NOW * 1000) });

  test("two rows for the same signer (two taps at once, any letter case) count once", () => {
    const counted = countApprovals(
      [
        { proposalId: P, signer: ALICE.key, revoked: false },
        { proposalId: P, signer: ALICE.key.toLowerCase(), revoked: false },
      ],
      [ALICE.key, BOB.key],
    );
    expect(counted.size).toBe(1);
  });

  test("a withdrawn vote and a non-member's vote are not counted", () => {
    const v = potView(
      baseInput({
        proposals: [prop()],
        signatures: [
          { proposalId: P, signer: ALICE.key, revoked: true },
          { proposalId: P, signer: CAROL, revoked: false },
          { proposalId: P, signer: BOB.key, revoked: false },
        ],
      }),
    );
    expect([v.proposals[0]!.approvals, v.proposals[0]!.required, v.proposals[0]!.signedByYou]).toEqual([1, 2, false]);
  });

  test("approvals required follow the pot's rule (60% of 2 members, rounded up = 2)", () => {
    expect(potView(baseInput()).rules.approvalsRequired).toBe(2);
  });
});

describe("pending, confirmed and failed proposals", () => {
  test("each status has fixed text; the stored error is never sent", () => {
    expect(proposalState("collecting", null, NOW).state).toBe("pending");
    expect(proposalState("ready", null, NOW).state).toBe("pending");
    expect(proposalState("queued", NOW + 10, NOW)).toEqual({ state: "pending", text: "Approved, in the exit window" });
    expect(proposalState("queued", NOW - 10, NOW)).toEqual({ state: "pending", text: "Exit window over, being executed" });
    expect(proposalState("executed", null, NOW).state).toBe("confirmed");
    for (const s of ["expired", "stale", "failed"] as const) expect(proposalState(s, null, NOW).state).toBe("failed");
    expect(proposalState("failed", null, NOW).text).toBe("The transaction failed");
  });

  test("a queued proposal shows when its exit window ends; a failed one keeps no error text", () => {
    const v = potView(
      baseInput({
        proposals: [
          { id: "0x01", kind: 0, summary: "Queued", status: "queued", queuedEta: NOW + 3600, deadline: NOW + 86400, txHash: null, createdAt: new Date((NOW - 10) * 1000) },
          { id: "0x02", kind: 0, summary: "Failed", status: "failed", queuedEta: null, deadline: NOW + 86400, txHash: "0xdead", createdAt: new Date(NOW * 1000) },
        ],
      }),
    );
    expect(v.proposals.map((p) => p.id)).toEqual(["0x02", "0x01"]); // newest first
    expect(v.proposals[1]!.executeAfter).toBe(new Date((NOW + 3600) * 1000).toISOString());
    expect(v.proposals[0]).not.toHaveProperty("error");
    expect(v.proposals[0]!.stateText).toBe("The transaction failed");
  });
});

describe("indexer lag and activity", () => {
  test("the indexer's block and whether it is behind are passed on", () => {
    const v = potView(baseInput({ indexer: { block: 999n, behind: true } }));
    expect(v.indexer).toEqual({ block: "999", behind: true });
  });

  test("activity: newest first, amounts as exact strings, unknown events left out, capped", () => {
    const ev = (block: bigint, logIndex: number, name: string, args: Record<string, unknown>) => ({ txHash: `0x${block}`, logIndex, block, name, args, at: new Date(NOW * 1000) });
    const items = activityFrom(
      [
        ev(10n, 0, "Deposited", { member: ALICE.key, amount: "123456789012345678901", shares: "1", navBefore: "0" }),
        ev(11n, 1, "Swapped", { adapter: CAROL, tokenIn: USDG, tokenOut: TSLA, amountIn: "100", fee: "1", amountOut: "7" }),
        ev(11n, 0, "SomethingNew", {}),
        ev(9n, 0, "Initialized", {}),
      ],
      USDG,
    );
    expect(items.map((i) => i.type)).toEqual(["swap", "deposit", "created"]);
    expect(items[1]!.amount).toBe("123456789012345678901");
    expect(items[0]).toMatchObject({ assetIn: USDG, assetOut: TSLA, amountIn: "100", amountOut: "7" });
    const many = Array.from({ length: 80 }, (_, i) => ev(BigInt(i), 0, "MemberAdded", { member: CAROL }));
    expect(activityFrom(many, USDG).length).toBe(MAX_ACTIVITY);
  });
});

describe("no data from outside the member's own pot", () => {
  test("the asset list names only assets this pot holds or its activity mentions", () => {
    const UNRELATED = getAddress("0x3333333333333333333333333333333333333333");
    const assets = new Map([
      [TSLA.toLowerCase(), { symbol: "TSLA", decimals: 18, isStock: true, multiplier: null }],
      [UNRELATED.toLowerCase(), { symbol: "NVDA", decimals: 18, isStock: true, multiplier: null }],
    ]);
    const v = potView(baseInput({ assets }));
    expect(Object.keys(v.assets)).toEqual([USDG]);
  });

  test("members come only from this pot's active member rows", () => {
    const v = potView(baseInput());
    expect(v.members.map((m) => m.address)).toEqual([ALICE.key, BOB.key]);
    expect(v.members.find((m) => m.you)!.address).toBe(ALICE.key);
  });
});

// ---------------------------------------------------------------- live prices

describe("live prices: the factory's own valuation, cached briefly", () => {
  const FACTORY = getAddress("0x5d03d53A5630ceCC545Be46635779094A11E47D7");
  test("one read per asset and amount within the cache time; read again after it", async () => {
    let reads = 0;
    let t = 0;
    const client = { readContract: async () => (reads++, 42n) } as never;
    const price = priceReader(client, FACTORY, () => t);
    expect(await price(TSLA, 10n)).toBe(42n);
    expect(await price(TSLA, 10n)).toBe(42n);
    expect(reads).toBe(1);
    t = PRICE_CACHE_MS + 1;
    await price(TSLA, 10n);
    expect(reads).toBe(2);
    expect(await price(TSLA, 0n)).toBe(0n); // nothing held: no read
    expect(reads).toBe(2);
  });

  test("a price the factory refuses (stale feed) is 'paused'; a chain failure is an error", async () => {
    const { ExecutionRevertedError, HttpRequestError } = await import("viem");
    const paused = priceReader({ readContract: async () => Promise.reject(new ExecutionRevertedError()) } as never, FACTORY);
    expect(await paused(TSLA, 1n)).toBeNull();
    const down = priceReader({ readContract: async () => Promise.reject(new HttpRequestError({ url: "https://rpc.example/KEY" })) } as never, FACTORY);
    await expect(down(TSLA, 1n)).rejects.toBeDefined();
  });
});

// ---------------------------------------------------------------- settings and links

describe("DASHBOARD_URL", () => {
  const base = {
    PUBLIC_URL: "https://sign.test",
    DATABASE_URL: "postgres://x/y",
    RHC_RPC_URL: "https://rpc.test",
    FACTORY_ADDRESS: "0x0d6e43d4d7944408d9a5A10BC57B4348d61cD764",
    ADAPTER_ADDRESS: "0xFCc4Ba754Ae127396D3c6dCA507389b5A5b6EFAe",
    RELAYER_PRIVATE_KEY: `0x${"0".repeat(63)}1`,
    TELEGRAM_BOT_TOKEN: "1:x",
    TELEGRAM_BOT_USERNAME: "b",
    TELEGRAM_WEBHOOK_SECRET: "0123456789abcdef",
    LINK_SECRET: secret,
  };
  test("an https origin is accepted (a trailing slash is dropped); unset is allowed", () => {
    expect(parseEnv({ ...base, DASHBOARD_URL: "https://testdashboard.getcofer.com/" }).DASHBOARD_URL).toBe("https://testdashboard.getcofer.com");
    expect(parseEnv({ ...base, DASHBOARD_URL: "https://dashboard.getcofer.com" }).DASHBOARD_URL).toBe("https://dashboard.getcofer.com");
    expect(parseEnv(base).DASHBOARD_URL).toBeUndefined();
    expect(parseEnv({ ...base, DASHBOARD_URL: "http://localhost:4173" }).DASHBOARD_URL).toBe("http://localhost:4173");
  });
  test("plain http (off localhost) or a path is refused", () => {
    expect(() => parseEnv({ ...base, DASHBOARD_URL: "http://dashboard.getcofer.com" })).toThrow();
    expect(() => parseEnv({ ...base, DASHBOARD_URL: "https://dashboard.getcofer.com/app" })).toThrow();
  });
  test("the token is found in both kinds of link (for cancelling a leaked one)", () => {
    expect(linkTokenOf("https://sign.test/s/abc.def")).toBe("abc.def");
    expect(linkTokenOf("https://dashboard.test/#t=abc.def")).toBe("abc.def");
  });
});
