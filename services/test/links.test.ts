import { describe, expect, test } from "bun:test";
import { ContractFunctionExecutionError, ContractFunctionRevertedError, ContractFunctionZeroDataError, getAddress, HttpRequestError } from "viem";
import { appRouter, type ApiCtx } from "../src/api/router";
import { signLink, verifyLink, type LinkClaims } from "../src/core/linkToken";
import { signerPage } from "../src/web/page";
import { isPasskeyRoot, KERNEL_ROOT_VALIDATOR_ABI, NOT_PASSKEY_ACCOUNT, PASSKEY_ROOT_VALIDATOR_ID } from "../src/core/accountKind";

const secret = "x".repeat(40);
const now = () => Math.floor(Date.now() / 1000);

/** In-memory stand-in for the link_tokens table; counts every write. */
function fakeDb() {
  const rows = new Map<string, { jti: string; usedAt: Date | null }>();
  let writes = 0;
  const db = {
    query: { linkTokens: { findFirst: async () => [...rows.values()][0] } },
    insert: () => ({
      values: (v: { jti: string; usedAt: Date }) => ({
        onConflictDoUpdate: () => ({
          returning: async () => {
            writes++;
            const row = rows.get(v.jti);
            if (row?.usedAt) return [];
            rows.set(v.jti, { jti: v.jti, usedAt: v.usedAt });
            return [{ jti: v.jti }];
          },
        }),
      }),
    }),
  };
  return { db, rows, writes: () => writes };
}

function caller(db: unknown) {
  const ctx: ApiCtx = { deps: { db } as unknown as ApiCtx["deps"], cards: {} as ApiCtx["cards"], secret, session: null };
  return appRouter.createCaller(ctx);
}

const link = (over: Partial<LinkClaims> = {}) =>
  signLink({ tg: 7, chat: -100, p: "deposit", ref: "0x0000000000000000000000000000000000000001", exp: now() + 900, jti: "j1", ...over }, secret);

describe("one-time signer links", () => {
  test("preview checks the link but never spends it or creates a session", async () => {
    const f = fakeDb();
    const api = caller(f.db);
    const a = await api.session.preview({ token: link() });
    const b = await api.session.preview({ token: link() });
    expect(a).toEqual({ used: false, purpose: "deposit", ref: "0x0000000000000000000000000000000000000001", proposal: null, linked: null });
    expect(b.used).toBe(false);
    expect(Object.keys(a)).not.toContain("session");
    expect(f.writes()).toBe(0);
  });

  test("preview rejects a bad signature and an expired link", async () => {
    const api = caller(fakeDb().db);
    const other = signLink({ tg: 7, chat: -100, p: "deposit", ref: "", exp: now() + 900, jti: "j1" }, "y".repeat(40));
    await expect(api.session.preview({ token: other })).rejects.toThrow("link expired or invalid");
    await expect(api.session.preview({ token: link({ exp: now() - 1 }) })).rejects.toThrow("link expired or invalid");
  });

  test("exchange spends the link once and gives a 1h session", async () => {
    const f = fakeDb();
    const api = caller(f.db);
    const ex = await api.session.exchange({ token: link() });
    const s = verifyLink(ex.session, secret);
    expect(s.p).toBe("session");
    expect(s.exp - now()).toBeGreaterThan(3590);
    expect(s.exp - now()).toBeLessThanOrEqual(3600);
    await expect(api.session.exchange({ token: link() })).rejects.toThrow("link already used");
    expect((await api.session.preview({ token: link() })).used).toBe(true);
  });

  test("exchange rejects an expired link", async () => {
    const api = caller(fakeDb().db);
    await expect(api.session.exchange({ token: link({ exp: now() - 1 }) })).rejects.toThrow("link expired or invalid");
  });
});

const A = getAddress("0x00000000000000000000000000000000000000aa");
const B = getAddress("0x00000000000000000000000000000000000000bb");

/** In-memory stand-in for the users table (one Telegram user); the upsert keeps an existing different address. */
function fakeUsers(address: string | null) {
  let row: { tgId: number; address: string | null } | undefined = address === null ? undefined : { tgId: 7, address };
  const db = {
    query: { users: { findFirst: async () => row }, linkTokens: { findFirst: async () => undefined } },
    insert: () => ({
      values: (v: { tgId: number; address: string }) => ({
        onConflictDoUpdate: () => ({
          returning: async () => {
            if (row?.address && row.address !== v.address) return [];
            row = { tgId: v.tgId, address: v.address };
            return [{ address: v.address }];
          },
        }),
      }),
    }),
  };
  return { db, row: () => row };
}

/** rootValidator() as the chain answers it: by default a Kernel account whose main key is the passkey validator. */
type RootRead = () => Promise<string>;
const passkeyRoot: RootRead = async () => PASSKEY_ROOT_VALIDATOR_ID;

function signedIn(db: unknown, rootValidator: RootRead = passkeyRoot) {
  const session: LinkClaims = { tg: 7, chat: -100, p: "session", ref: "", exp: now() + 3600, jti: "s1" };
  const deps = { db, client: { verifyMessage: async () => true, readContract: rootValidator } } as unknown as ApiCtx["deps"];
  return appRouter.createCaller({ deps, cards: {} as ApiCtx["cards"], secret, session });
}

describe("one key per Telegram account", () => {
  test("sign-up preview shows the key this Telegram user already has", async () => {
    const api = caller(fakeUsers(A).db);
    const p = await api.session.preview({ token: link({ p: "onboard", ref: "", chat: 7 }) }); // onboarding links are DM-only (chat = user)
    expect(p.linked).toBe(A);
  });

  test("sign-up preview has no key for a new user", async () => {
    const api = caller(fakeUsers(null).db);
    expect((await api.session.preview({ token: link({ p: "onboard", ref: "", chat: 7 }) })).linked).toBeNull();
  });

  test("linking works for a new user and again for the same address (a retry)", async () => {
    const f = fakeUsers(null);
    const api = signedIn(f.db);
    expect(await api.me.link({ address: A, signature: "0x01", kind: "kernel-passkey" })).toEqual({ ok: true });
    expect(await api.me.link({ address: A.toLowerCase(), signature: "0x01", kind: "kernel-passkey" })).toEqual({ ok: true });
    expect(f.row()?.address).toBe(A);
  });

  test("linking a different address is refused and the first one stays", async () => {
    const f = fakeUsers(A);
    const api = signedIn(f.db);
    await expect(api.me.link({ address: B, signature: "0x01", kind: "kernel-passkey" })).rejects.toThrow(
      `this Telegram account already has a Cofer key (${A}); replacing a key is not supported yet`,
    );
    expect(f.row()?.address).toBe(A);
  });
});

describe("signer page phone notice", () => {
  const html = signerPage("tok", { chainId: 46630, rpcUrl: "https://rpc.example", bundlerUrl: "", paymasterUrl: "", passkeyServerUrl: "", usdg: "0x0000000000000000000000000000000000000001" });

  test("has the exact notice text and a Got it button, hidden until a phone is detected", () => {
    expect(html).toContain(">Open in your browser (recommended)<");
    expect(html).toContain(
      "For your passkey (Face ID or fingerprint) to work, open this page in your phone's browser. In Telegram, tap ••• and choose Open in browser (on iPhone: Open in Safari).",
    );
    expect(html).toContain(">Got it</button>");
    expect(html).toMatch(/<div id="notice"[^>]* hidden>/);
  });

  test("loads no external scripts or styles", () => {
    const srcs = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
    expect(srcs).toEqual(["/assets/signer.js"]);
    expect(html).not.toMatch(/<link[^>]+stylesheet/i);
    expect(html).not.toMatch(/@import|https?:\/\/[^"]*\.(css|js)\b/i);
  });
});

describe("the kernel-passkey label is saved only for a passkey account", () => {
  const readErr = (cause: Error) =>
    new ContractFunctionExecutionError(cause as never, { abi: KERNEL_ROOT_VALIDATOR_ABI, functionName: "rootValidator", contractAddress: A as `0x${string}` });

  test("the expected root key is the validator type byte 0x01 then the passkey validator 0.0.3", () => {
    expect(PASSKEY_ROOT_VALIDATOR_ID).toBe("0x017ab16Ff354AcB328452F1D445b3Ddee9a91e9e69");
    expect(isPasskeyRoot(PASSKEY_ROOT_VALIDATOR_ID.toLowerCase())).toBe(true);
    expect(isPasskeyRoot("0x00" + PASSKEY_ROOT_VALIDATOR_ID.slice(4))).toBe(false); // wrong type byte
    expect(isPasskeyRoot(undefined)).toBe(false);
  });

  test("a Kernel account whose main key is the passkey validator is saved as kernel-passkey", async () => {
    const f = fakeUsers(null);
    expect(await signedIn(f.db).me.link({ address: A, signature: "0x01", kind: "kernel-passkey" })).toEqual({ ok: true });
    expect(f.row()?.address).toBe(A);
  });

  test("a Kernel account with another main key (for example a wallet signer) is refused, nothing saved", async () => {
    const f = fakeUsers(null);
    const ecdsaRoot: RootRead = async () => "0x01845ADb2C711129d4f3966735eD98a9F09fC4cE57";
    await expect(signedIn(f.db, ecdsaRoot).me.link({ address: A, signature: "0x01", kind: "kernel-passkey" })).rejects.toThrow(NOT_PASSKEY_ACCOUNT);
    expect(f.row()).toBeUndefined();
  });

  test("a plain wallet (no contract: the read comes back empty) is refused under kernel-passkey, nothing saved", async () => {
    const f = fakeUsers(null);
    const empty: RootRead = async () => {
      throw readErr(new ContractFunctionZeroDataError({ functionName: "rootValidator" }));
    };
    await expect(signedIn(f.db, empty).me.link({ address: A, signature: "0x01", kind: "kernel-passkey" })).rejects.toThrow(NOT_PASSKEY_ACCOUNT);
    expect(f.row()).toBeUndefined();
  });

  test("another contract that reverts on rootValidator() is refused, nothing saved", async () => {
    const f = fakeUsers(null);
    const reverts: RootRead = async () => {
      throw readErr(new ContractFunctionRevertedError({ abi: KERNEL_ROOT_VALIDATOR_ABI, functionName: "rootValidator" }));
    };
    await expect(signedIn(f.db, reverts).me.link({ address: A, signature: "0x01", kind: "kernel-passkey" })).rejects.toThrow(NOT_PASSKEY_ACCOUNT);
    expect(f.row()).toBeUndefined();
  });

  test("a chain we cannot reach is not a refusal: fixed retry text, nothing saved", async () => {
    const f = fakeUsers(null);
    const down: RootRead = async () => {
      throw readErr(new HttpRequestError({ url: "https://rpc.example/KEY", details: "fetch failed" }));
    };
    const err = await signedIn(f.db, down).me.link({ address: A, signature: "0x01", kind: "kernel-passkey" }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err.message)).not.toContain(NOT_PASSKEY_ACCOUNT);
    expect(f.row()).toBeUndefined();
  });
});
