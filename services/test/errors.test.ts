import { describe, expect, spyOn, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ContractFunctionRevertedError, encodeErrorResult, ExecutionRevertedError, HttpRequestError, RpcRequestError, TimeoutError } from "viem";
import { coferFactoryAbi } from "../src/chain/abi";
import postgres from "postgres";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { errorKind, GENERIC_ERROR_TEXT, logError, redact, revertName, RPC_ERROR_TEXT, safeError, UserError, userMessage } from "../src/core/errors";
import { ProposalError } from "../src/services/proposals";
import { parseBuy } from "../src/bot/parse";

const SECRET_URL = "https://rhc-mainnet.example-rpc.io/v2/SECRETKEY123?apikey=SECRETKEY123";
const httpError = () => new HttpRequestError({ url: SECRET_URL, details: "fetch failed", body: { method: "eth_call" } });

describe("what reaches a Telegram chat", () => {
  test("viem RPC errors carry the URL in their message, and userMessage never does", () => {
    const e = httpError();
    expect(e.message).toContain("SECRETKEY123"); // the leak this guards against
    expect(userMessage(e)).toBe(RPC_ERROR_TEXT);
    expect(userMessage(new TimeoutError({ body: {}, url: SECRET_URL }))).toBe(RPC_ERROR_TEXT);
    expect(userMessage(new Error(`boom at ${SECRET_URL}`))).toBe(RPC_ERROR_TEXT); // unknown => fixed text
    for (const t of [RPC_ERROR_TEXT, GENERIC_ERROR_TEXT]) expect(t).not.toMatch(/https?:|SECRET/);
  });

  test("only messages written for members pass through", () => {
    expect(userMessage(new UserError("percent 0.01..100"))).toBe("percent 0.01..100");
    expect(userMessage(new ProposalError("only members can propose"))).toBe("only members can propose");
    expect(() => parseBuy("/buy")).toThrow(UserError);
  });

  test("a contract revert is not an RPC error", () => {
    expect(errorKind(new ExecutionRevertedError({ message: "execution reverted: Unexpected error" }))).toBe("revert");
    expect(userMessage(new ExecutionRevertedError({}))).toBe(GENERIC_ERROR_TEXT);
    expect(errorKind(httpError())).toBe("rpc");
    expect(errorKind(new RpcRequestError({ body: {}, url: SECRET_URL, error: { code: -32000, message: "out of gas" } }))).toBe("revert");
    expect(errorKind(new RpcRequestError({ body: {}, url: SECRET_URL, error: { code: -32005, message: "rate limited" } }))).toBe("rpc");
  });

  test("revertName reads the contract's error (StalePrice = price paused)", () => {
    const data = encodeErrorResult({ abi: coferFactoryAbi, errorName: "StalePrice", args: ["0x322F0929c4625eD5bAd873c95208D54E1c003b2d"] });
    const e = new ContractFunctionRevertedError({ abi: coferFactoryAbi, functionName: "quote", data });
    expect(revertName(e)).toBe("StalePrice");
    expect(errorKind(e)).toBe("revert");
    expect(revertName(httpError())).toBeUndefined();
  });
});

describe("logs", () => {
  test("redact removes every URL", () => {
    expect(redact(`URL: ${SECRET_URL}\nRequest body: {}`)).toBe("URL: <url>\nRequest body: {}");
    expect(redact("wss://a.b/c?key=1 and http://x")).toBe("<url> and <url>");
  });

  test("logError never prints the URL", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    logError("bot", httpError());
    const printed = spy.mock.calls.flat().join(" ");
    spy.mockRestore();
    expect(printed).toContain("[bot]");
    expect(printed).not.toContain("SECRETKEY123");
  });
});

describe("logs show the real reason under a wrapper", () => {
  const captureLog = (e: unknown) => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    logError("cofer-keeper holdings", e);
    const printed = spy.mock.calls.flat().join(" ");
    spy.mockRestore();
    return printed;
  };
  // The real shapes from the keeper: Drizzle's "Failed query" wrapping the driver's PostgresError.
  const pgError = () =>
    new postgres.PostgresError({ message: 'malformed array literal: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"', code: "22P02", severity: "ERROR" } as never);
  const failedQuery = (cause: unknown) => new DrizzleQueryError("delete from holdings where pot = $1 and not (asset = any(($2)))", ["0xpot"], cause as Error);

  test("a Drizzle failed query logs the Postgres reason and code", () => {
    const printed = captureLog(failedQuery(pgError()));
    expect(printed).toContain("Failed query: delete from holdings");
    expect(printed).toContain("Caused by: PostgresError [22P02]: malformed array literal");
  });

  test("the same reason survives the job queue's cleaned copy (what the worker's failed event logs)", () => {
    const printed = captureLog(safeError(failedQuery(pgError())));
    expect(printed).toContain("Caused by: PostgresError [22P02]: malformed array literal");
  });

  test("no URL, key or database password at any level", () => {
    const deep = failedQuery(new Error(`connect failed for postgres://cofer:DBPASSWORD@db.internal:5432/cofer`, { cause: httpError() }));
    for (const printed of [captureLog(deep), captureLog(safeError(deep))]) {
      expect(printed).toContain("Caused by:");
      expect(printed).not.toContain("DBPASSWORD");
      expect(printed).not.toContain("SECRETKEY123");
    }
  });

  test("the chain stops after 5 causes and survives an error that is its own cause", () => {
    let e: Error = new Error("level 0");
    for (let i = 1; i <= 8; i++) e = new Error(`level ${i}`, { cause: e });
    expect(captureLog(e).match(/Caused by:/g)!.length).toBe(5);
    const loop = new Error("loop");
    (loop as { cause?: unknown }).cause = loop;
    expect(captureLog(loop).match(/Caused by:/g)!.length).toBe(5);
    expect(captureLog(safeError(loop)).match(/Caused by:/g)!.length).toBe(5);
  });
});

describe("bot source guard", () => {
  test("no bot reply is built from an error's own message", () => {
    const dir = join(import.meta.dir, "..", "src", "bot");
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
      const src = readFileSync(join(dir, f), "utf8");
      expect({ f, hit: /\b(e|err|error)\s*(as\s+Error\s*\))?\s*\)?\.(message|shortMessage|details)\b/.test(src) }).toEqual({ f, hit: false });
      expect({ f, hit: /console\.(error|log|warn)\(/.test(src) }).toEqual({ f, hit: false }); // logs go through logError
    }
  });
});
