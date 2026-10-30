import { describe, expect, test } from "bun:test";
import { appRouter, type ApiCtx } from "../src/api/router";
import { signLink, verifyLink, type LinkClaims } from "../src/core/linkToken";
import { signerPage } from "../src/web/page";

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
    expect(a).toEqual({ used: false, purpose: "deposit", ref: "0x0000000000000000000000000000000000000001", proposal: null });
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
