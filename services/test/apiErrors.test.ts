import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { HttpRequestError } from "viem";
import { appRouter, type ApiCtx } from "../src/api/router";
import { signLink, verifyLink } from "../src/core/linkToken";
import { GENERIC_ERROR_TEXT, RPC_UNREACHABLE_TEXT } from "../src/core/errors";

const SECRET_URL = "https://api-robinhood-mainnet-archive.n.dwellir.com/SECRETKEY123";
const POT = "0x0000000000000000000000000000000000000abc";
const LINK_SECRET = "test-secret";

/** A request through the real signer API; `client`/`db` stand in for the chain and Postgres. */
async function call(path: string, input: unknown, deps: { client?: unknown; db?: unknown }) {
  const token = signLink({ tg: 1, chat: 2, p: "session", ref: "", exp: Math.floor(Date.now() / 1000) + 600, jti: "j" }, LINK_SECRET);
  const req = new Request(`http://local/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`, { headers: { authorization: `Bearer ${token}` } });
  const res = await fetchRequestHandler({
    endpoint: "/trpc",
    req,
    router: appRouter,
    createContext: () => ({ deps: deps as ApiCtx["deps"], cards: {} as ApiCtx["cards"], secret: LINK_SECRET, session: verifyLink(token, LINK_SECRET) }) as ApiCtx,
  });
  return { status: res.status, body: await res.text() };
}

describe("signer API errors", () => {
  test("an RPC failure reaches the browser as fixed text: no URL, no key, no stack", async () => {
    const client = {
      readContract: async () => {
        throw new HttpRequestError({ url: SECRET_URL, details: "fetch failed" });
      },
    };
    const { status, body } = await call("pot.get", { pot: POT }, { client, db: {} });
    expect(status).toBe(500);
    expect(JSON.parse(body).error.message).toBe(RPC_UNREACHABLE_TEXT);
    expect(body).not.toContain("SECRETKEY123");
    expect(body).not.toContain("dwellir");
    expect(body).not.toMatch(/"stack"/);
  });

  test("any other unexpected error is fixed text too", async () => {
    const client = {
      readContract: async () => {
        throw new TypeError(`cannot read x of undefined at ${SECRET_URL}`);
      },
    };
    const { body } = await call("pot.get", { pot: POT }, { client, db: {} });
    expect(JSON.parse(body).error.message).not.toContain("SECRETKEY123");
    expect([RPC_UNREACHABLE_TEXT, GENERIC_ERROR_TEXT]).toContain(JSON.parse(body).error.message);
  });

  test("messages written for members still get through", async () => {
    const db = { query: { proposals: { findFirst: async () => undefined } } };
    const { status, body } = await call("proposal.get", { id: "0x01" }, { client: {}, db });
    expect(status).toBe(400);
    expect(JSON.parse(body).error.message).toBe("unknown proposal");
  });

  test("the server logs API errors only through logError, and has a plain error page", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "api", "server.ts"), "utf8");
    expect(src).toMatch(/onError: \(\{ error, path \}\) =>[\s\S]*logError\(/);
    expect(src).toMatch(/app\.onError\(\(err, c\) => \{\s*logError\("api", err\);\s*return c\.text\("Internal error", 500\);/);
  });
});
