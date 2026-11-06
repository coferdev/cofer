/**
 * Dashboard phase 2a: action buttons that hand off to the signer page. The dashboard never signs;
 * POST /api/dashboard/links makes the same one-time signer link the bot makes, for the session's
 * own member and pot only. Here: the disabled-button rules and reasons, exact decimals at the
 * limits, the route's refusals, and that the links are of the right purpose, single-use (through the
 * real signer exchange) and distinct when opened at the same moment. No database, chain or network.
 */
import { describe, expect, test } from "bun:test";
import { getAddress, type Address } from "viem";
import { appRouter, type ApiCtx } from "../src/api/router";
import { signLink, verifyLink, type LinkClaims } from "../src/core/linkToken";
import { DEPOSITS_CLOSED_TEXT } from "../src/core/depositGate";
import { roomText } from "../src/core/betaCap";
import { approveAvailability, claimAvailability, depositAvailability, owedFromEvents, spendAvailability, TEXT as A } from "../src/dashboard/actions";
import { dashboardRoutes, parseLinkRequest, SIGNER_LINK_TTL_SEC, TEXT, type DashboardDeps } from "../src/dashboard/routes";
import { potView, type PotViewInput, type ProposalRow } from "../src/dashboard/view";

const secret = "d".repeat(40);
const SIGNER = "https://sign.test";
const NOW = 1_800_000_000;
const USDG = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
const TSLA = getAddress("0x322F0929c4625eD5bAd873c95208D54E1c003b2d");
const POT = getAddress("0x2D3365a056074f6cd35C943EDcE644FAE7Eb8A45");
const OTHER_POT = getAddress("0x1111111111111111111111111111111111111111");
const ALICE = { tg: 101, key: getAddress("0x000000000000000000000000000000000000a11c") };
const BOB = { tg: 102, key: getAddress("0x00000000000000000000000000000000000b0b00") };
const PROP = `0x${"ab".repeat(32)}`; // POT's open proposal
const SIGNED = `0x${"cd".repeat(32)}`; // POT's proposal Alice already approved
const DONE = `0x${"ef".repeat(32)}`; // POT's executed proposal
const BOBS = `0x${"12".repeat(32)}`; // OTHER_POT's proposal

const prop = (id: string, over: Partial<ProposalRow> = {}): ProposalRow => ({ id, kind: 0, summary: "Send 10 USDG", status: "collecting", queuedEta: null, deadline: NOW + 86400, txHash: null, createdAt: new Date(NOW * 1000), ...over });

function input(me: Address, over: Partial<PotViewInput> = {}): PotViewInput {
  return {
    chainId: 46630,
    usdg: USDG,
    me,
    now: NOW,
    pot: { address: POT, title: "Trip fund", threshold: 2, thresholdBps: 6000, guardDelay: 21600, depositsOpen: true, totalShares: "3000", planPaidUntil: null },
    members: [
      { address: ALICE.key, shares: "1000", allowance: "50000000", period: 604800, username: "alice" },
      { address: BOB.key, shares: "2000", allowance: "0", period: 0, username: "bob" },
    ],
    proposals: [prop(PROP), prop(SIGNED), prop(DONE, { status: "executed", txHash: "0x01" })],
    signatures: [{ proposalId: SIGNED, signer: ALICE.key, revoked: false }],
    holdings: [],
    assets: new Map(),
    events: [],
    myAllowance: { allowance: 50_000_000n, period: 604800, periodStart: NOW - 10, spent: 0n },
    indexer: { block: 1n, behind: false },
    deposit: { stalePrice: null, nav: 1_000_000_000n },
    owed: [],
    ...over,
  };
}

/** Alice is a member of POT only; Bob of OTHER_POT only. `over` changes Alice's view of POT. */
function deps(over: Partial<PotViewInput> = {}): DashboardDeps {
  return {
    secret,
    chainId: 46630,
    signerUrl: SIGNER,
    now: () => NOW,
    spendLink: async () => true,
    keyOf: async (tg) => (tg === ALICE.tg ? ALICE.key : tg === BOB.tg ? BOB.key : null),
    potsOf: async () => [],
    potInput: async (pot, member) => {
      if (pot === POT && member === ALICE.key) return input(ALICE.key, over);
      if (pot === OTHER_POT && member === BOB.key) return input(BOB.key, { pot: { ...input(BOB.key).pot, address: OTHER_POT }, proposals: [prop(BOBS)] });
      return null;
    },
  };
}

const session = (tg = ALICE.tg, p: LinkClaims["p"] = "dash") => signLink({ tg, chat: tg, p, ref: "", exp: NOW + 1800, jti: `s${Math.random()}` }, secret);
function ask(d: DashboardDeps, body: unknown, s: string | null = session()) {
  return dashboardRoutes(d).request("http://x/links", {
    method: "POST",
    headers: { "content-type": "application/json", ...(s ? { authorization: `Bearer ${s}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
async function linkOf(r: Response) {
  const b = (await r.json()) as { url: string; expiresAt: string };
  expect(b.url).toStartWith(`${SIGNER}/s/`);
  // decoded with the signature checked; expiry is asserted where it matters (some tests use the real clock)
  return { claims: verifyLink(b.url.slice(`${SIGNER}/s/`.length), secret, 0), token: b.url.slice(`${SIGNER}/s/`.length), expiresAt: b.expiresAt };
}

// ---------------------------------------------------------------- the rules behind each button

describe("disabled buttons say why", () => {
  test("deposit: closed by the group, a stock price older than 12 hours, the beta limit reached", () => {
    expect(depositAvailability({ depositsOpen: false, stalePrice: null, nav: 0n })).toEqual({ ok: false, reason: A.depositsClosedByGroup });
    expect(depositAvailability({ depositsOpen: true, stalePrice: { asset: TSLA, ageSec: 13 * 3600 }, nav: 0n })).toEqual({ ok: false, reason: DEPOSITS_CLOSED_TEXT });
    const cap = 5_000_000_000n;
    expect(depositAvailability({ depositsOpen: true, stalePrice: null, nav: cap, cap })).toEqual({ ok: false, reason: roomText(cap, cap) });
    expect(depositAvailability({ depositsOpen: true, stalePrice: null, nav: cap - 1n, cap }).ok).toBe(true); // one USDG unit (0.000001) of room is room
    expect(depositAvailability({ depositsOpen: true, stalePrice: null, nav: cap * 10n, cap: null }).ok).toBe(true); // limit off
  });

  test("deposit: a check that could not be read leaves the button on (the signer page and the contract check again)", () => {
    expect(depositAvailability({ depositsOpen: true, stalePrice: undefined, nav: null }).ok).toBe(true);
  });

  test("spend: no allowance, allowance used up; one unit left is enough", () => {
    expect(spendAvailability({ allowance: 0n, allowanceLeft: 0n })).toEqual({ ok: false, reason: A.noAllowance });
    expect(spendAvailability({ allowance: 50_000_000n, allowanceLeft: 0n })).toEqual({ ok: false, reason: A.allowanceUsed });
    expect(spendAvailability({ allowance: 50_000_000n, allowanceLeft: 1n }).ok).toBe(true);
    expect(spendAvailability({ allowance: null, allowanceLeft: null }).ok).toBe(true);
  });

  test("claim: only when something is set aside", () => {
    expect(claimAvailability([])).toEqual({ ok: false, reason: A.nothingSetAside });
    expect(claimAvailability([0n, 0n]).ok).toBe(false);
    expect(claimAvailability([0n, 1n]).ok).toBe(true);
  });

  test("approve: executed, expired, cancelled, failed, waiting, past its deadline, already signed", () => {
    const at = (status: ProposalRow["status"], extra: Partial<{ deadline: number; signedByYou: boolean }> = {}) =>
      approveAvailability({ status, deadline: NOW + 60, now: NOW, signedByYou: false, ...extra });
    expect(at("executed").reason).toBe(A.executed);
    expect(at("expired").reason).toBe(A.expired);
    expect(at("stale").reason).toBe(A.stale);
    expect(at("failed").reason).toBe(A.failed);
    expect(at("queued").reason).toBe(A.queued);
    expect(at("collecting", { deadline: NOW }).reason).toBe(A.expired);
    expect(at("collecting", { signedByYou: true }).reason).toBe(A.alreadySigned);
    expect(at("collecting").ok).toBe(true);
    expect(at("ready").ok).toBe(true); // more approvals still count (a unanimous vote does not wait)
  });

  test("exit is never disabled, whatever else is closed", () => {
    const v = potView(input(ALICE.key, { pot: { ...input(ALICE.key).pot, depositsOpen: false }, deposit: { stalePrice: { asset: TSLA, ageSec: 99999 }, nav: 10n ** 30n }, myAllowance: null }));
    expect(v.actions.exit).toEqual({ ok: true, reason: null });
    expect(v.actions.deposit.ok).toBe(false);
  });

  test("the view carries each proposal's approve state and the group-chat hints", () => {
    const v = potView(input(ALICE.key));
    expect(v.proposals.find((p) => p.id === PROP)!.approve.ok).toBe(true);
    expect(v.proposals.find((p) => p.id === SIGNED)!.approve.reason).toBe(A.alreadySigned);
    expect(v.proposals.find((p) => p.id === DONE)!.approve.reason).toBe(A.executed);
    expect(v.groupHints.map((h) => h.hint)).toContain("Use /send in the group");
  });
});

describe("decimals: set-aside amounts are exact integers", () => {
  test("ExitOwed minus OwedClaimed, per asset, for this member only, any letter case, past 2^53", () => {
    const big = "123456789012345678901234567";
    const owed = owedFromEvents(
      [
        { name: "ExitOwed", args: { asset: TSLA, account: ALICE.key.toLowerCase(), amount: big } },
        { name: "OwedClaimed", args: { asset: TSLA.toLowerCase(), account: ALICE.key, amount: "1" } },
        { name: "ExitOwed", args: { asset: TSLA, account: BOB.key, amount: "999" } }, // someone else's
        { name: "ExitOwed", args: { asset: USDG, account: ALICE.key, amount: "5" } },
        { name: "OwedClaimed", args: { asset: USDG, account: ALICE.key, amount: "5" } },
        { name: "ExitOwed", args: { asset: USDG, account: ALICE.key, amount: "1.5" } }, // not a whole number: ignored
      ],
      ALICE.key,
    );
    expect(owed).toEqual([
      { asset: TSLA.toLowerCase(), amount: BigInt(big) - 1n },
      { asset: USDG.toLowerCase(), amount: 0n },
    ]);
    expect(claimAvailability(owed.map((o) => o.amount)).ok).toBe(true);
  });
});

// ---------------------------------------------------------------- the link route

describe("POST /links refuses", () => {
  test("a missing session, a signer session, an expired or forged session -> 401", async () => {
    const d = deps();
    for (const s of [null, session(ALICE.tg, "session"), session(ALICE.tg, "dashboard"), signLink({ tg: ALICE.tg, chat: ALICE.tg, p: "dash", ref: "", exp: NOW - 1, jti: "x" }, secret), signLink({ tg: ALICE.tg, chat: ALICE.tg, p: "dash", ref: "", exp: NOW + 60, jti: "x" }, "y".repeat(40))]) {
      expect((await ask(d, { pot: POT, action: "deposit" }, s)).status).toBe(401);
    }
  });

  test("a pot the member is not in, and a pot that does not exist: the same 404", async () => {
    const d = deps();
    const notMine = await ask(d, { pot: OTHER_POT, action: "exit" });
    const missing = await ask(d, { pot: `0x${"9".repeat(40)}`, action: "exit" });
    expect([notMine.status, missing.status]).toEqual([404, 404]);
    expect(await notMine.text()).toBe(await missing.text());
  });

  test("another member's id (or any extra field) -> 400; the link is only ever for the session's member", async () => {
    const d = deps();
    for (const extra of [{ member: BOB.key }, { tg: BOB.tg }, { chat: -100 }, { ref: "x" }]) {
      expect((await ask(d, { pot: POT, action: "exit", ...extra })).status).toBe(400);
    }
    const { claims } = await linkOf(await ask(d, { pot: POT, action: "exit" }, session(ALICE.tg)));
    expect([claims.tg, claims.chat]).toEqual([ALICE.tg, ALICE.tg]);
  });

  test("a malformed pot, action or proposal, or a body that is not an object -> 400", async () => {
    const d = deps();
    const bad = [
      { pot: "nope", action: "exit" },
      { pot: POT.slice(0, 41), action: "exit" },
      { pot: POT, action: "send" },
      { pot: POT, action: "approve" },
      { pot: POT, action: "approve", proposal: "0x12" },
      { pot: POT, action: "deposit", proposal: PROP },
      [POT, "exit"],
      null,
    ];
    for (const b of bad) expect((await ask(d, b)).status).toBe(400);
    expect((await ask(d, "{not json")).status).toBe(400);
    expect(parseLinkRequest({ pot: POT, action: "approve", proposal: PROP })).toEqual({ pot: POT, action: "approve", proposal: PROP });
  });

  test("approving another pot's proposal, or an unknown one -> 404", async () => {
    const d = deps();
    expect((await ask(d, { pot: POT, action: "approve", proposal: BOBS })).status).toBe(404);
    expect((await ask(d, { pot: POT, action: "approve", proposal: `0x${"77".repeat(32)}` })).status).toBe(404);
  });

  test("an action that cannot work right now -> 409 with the same plain reason as the button", async () => {
    const closed = deps({ pot: { ...input(ALICE.key).pot, depositsOpen: false } });
    const r = await ask(closed, { pot: POT, action: "deposit" });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: A.depositsClosedByGroup });
    const noAllowance = deps({ myAllowance: { allowance: 0n, period: 0, periodStart: 0, spent: 0n } });
    expect(await (await ask(noAllowance, { pot: POT, action: "spend" })).json()).toEqual({ error: A.noAllowance });
    expect(await (await ask(deps(), { pot: POT, action: "claim" })).json()).toEqual({ error: A.nothingSetAside });
    expect(await (await ask(deps(), { pot: POT, action: "approve", proposal: SIGNED })).json()).toEqual({ error: A.alreadySigned });
    expect(await (await ask(deps(), { pot: POT, action: "approve", proposal: DONE })).json()).toEqual({ error: A.executed });
  });

  test("a failed read -> 503 with fixed text", async () => {
    const d = { ...deps(), potInput: async () => Promise.reject(new Error("db down at https://db.example/KEY")) };
    const r = await ask(d, { pot: POT, action: "exit" });
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: TEXT.down });
  });
});

describe("POST /links makes the bot's own signer links", () => {
  test("each action gets the right purpose and reference, for 15 minutes", async () => {
    const d = deps({ owed: [{ asset: TSLA, amount: 1n }] });
    const cases: [Record<string, string>, string, string][] = [
      [{ action: "deposit" }, "deposit", POT],
      [{ action: "exit" }, "exit", POT],
      [{ action: "claim" }, "claim", POT],
      [{ action: "spend" }, "sign", `spend:${POT}`],
      [{ action: "approve", proposal: PROP }, "sign", PROP],
    ];
    for (const [body, p, ref] of cases) {
      const { claims, expiresAt } = await linkOf(await ask(d, { pot: POT.toLowerCase(), ...body }));
      expect([claims.p, claims.ref, claims.exp]).toEqual([p, ref, NOW + SIGNER_LINK_TTL_SEC]);
      expect(expiresAt).toBe(new Date((NOW + SIGNER_LINK_TTL_SEC) * 1000).toISOString());
    }
  });

  /** The real signer API exchange, with an in-memory link_tokens table. */
  function signerExchange() {
    const used = new Set<string>();
    const db = {
      insert: () => ({
        values: (v: { jti: string }) => ({
          onConflictDoUpdate: () => ({
            returning: async () => {
              await new Promise((r) => setTimeout(r, 1));
              if (used.has(v.jti)) return [];
              used.add(v.jti);
              return [{ jti: v.jti }];
            },
          }),
        }),
      }),
    };
    const api = appRouter.createCaller({ deps: { db } as unknown as ApiCtx["deps"], cards: null, secret, session: null });
    return async (token: string) => {
      try {
        return (await api.session.exchange({ token })).purpose;
      } catch (e) {
        return `refused: ${(e as Error).message}`;
      }
    };
  }

  test("single-use: the signer page accepts the link once, then refuses it", async () => {
    // the signer API checks expiry against the real clock: make the link at the real time
    const d = { ...deps(), now: () => Math.floor(Date.now() / 1000) };
    const exchange = signerExchange();
    const { token } = await linkOf(await ask(d, { pot: POT, action: "deposit" }));
    expect(await exchange(token)).toBe("deposit");
    expect(await exchange(token)).toBe("refused: link already used");
  });

  test("simultaneous opens: separate links, each usable once", async () => {
    const d = { ...deps(), now: () => Math.floor(Date.now() / 1000) };
    const exchange = signerExchange();
    const tokens = await Promise.all(Array.from({ length: 5 }, async () => (await linkOf(await ask(d, { pot: POT, action: "approve", proposal: PROP }))).token));
    expect(new Set(tokens.map((t) => verifyLink(t, secret).jti)).size).toBe(5);
    const first = await Promise.all(tokens.map(exchange));
    expect(first).toEqual(["sign", "sign", "sign", "sign", "sign"]);
    const again = await Promise.all([...tokens, ...tokens].map(exchange));
    expect(again.every((x) => x === "refused: link already used")).toBe(true);
  });

  test("the dashboard session itself never becomes a signer session", async () => {
    const exchange = signerExchange();
    expect(await exchange(signLink({ tg: ALICE.tg, chat: ALICE.tg, p: "dash", ref: "", exp: Math.floor(Date.now() / 1000) + 600, jti: "d1" }, secret))).toStartWith("refused:");
  });
});
