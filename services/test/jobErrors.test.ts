import { describe, expect, spyOn, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { HttpRequestError } from "viem";
import { logError, safeError, safeJob } from "../src/core/errors";

const RPC = "https://api-robinhood-mainnet-archive.n.dwellir.com/SECRETKEY123";
const TG = "https://api.telegram.org/bot123456:BOTTOKENSECRET/sendMessage";
const SRC = join(import.meta.dir, "..", "src");
const read = (...p: string[]) => readFileSync(join(SRC, ...p), "utf8");

describe("background jobs never store or log URLs", () => {
  test("safeError keeps the name and the text, minus every URL, in message and stack", () => {
    const e = safeError(new HttpRequestError({ url: RPC, details: "fetch failed" }));
    expect(e.name).toBe("HttpRequestError");
    expect(e.message).toContain("fetch failed");
    expect(e.message).toContain("<url>");
    for (const s of [e.message, e.stack ?? ""]) {
      expect(s).not.toContain("SECRETKEY123");
      expect(s).not.toContain("dwellir");
    }
    expect(safeError(new Error(`edit failed at ${TG}`)).message).not.toContain("BOTTOKENSECRET");
    expect(safeError("plain string").message).toBe("plain string");
  });

  test("a failing job still fails (so retries happen) but with the safe error; success is untouched", async () => {
    const ok = safeJob(async (x: number) => x * 2);
    expect(await ok(21)).toBe(42);
    const bad = safeJob(async () => {
      throw new HttpRequestError({ url: RPC, details: "fetch failed" });
    });
    let caught: unknown;
    try {
      await bad();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error;
    // what BullMQ stores in Redis: failedReason = err.message, stacktrace = err.stack
    expect(err.message).not.toContain("SECRETKEY123");
    expect(err.stack).not.toContain("SECRETKEY123");
    expect((err as { cause?: unknown }).cause).toBeUndefined(); // the original (with its URL) is not carried along
  });

  test("logging a Telegram error never prints the bot token", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    logError("notifier", new Error(`Network request to ${TG} failed`));
    const printed = spy.mock.calls.flat().join(" ");
    spy.mockRestore();
    expect(printed).not.toContain("BOTTOKENSECRET");
  });
});

describe("source guards", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
    });

  test("server code logs errors only through logError; the signer page has its one console call", () => {
    const hits: string[] = [];
    for (const f of files(SRC)) {
      const rel = relative(SRC, f);
      if (rel === join("core", "errors.ts")) continue;
      for (const m of readFileSync(f, "utf8").matchAll(/console\.(error|warn)\(/g)) hits.push(`${rel}:${m[0]}`);
    }
    expect(hits).toEqual([`${join("web", "client.ts")}:console.error(`]); // runs in the member's browser, never on the server
  });

  test("every background worker starts through startWorker, which wraps the job and logs safely", () => {
    for (const f of files(SRC)) {
      if (relative(SRC, f) === "queues.ts") continue;
      expect({ f: relative(SRC, f), worker: /new Worker\(/.test(readFileSync(f, "utf8")) }).toEqual({ f: relative(SRC, f), worker: false });
    }
    const q = read("queues.ts");
    expect(q).toContain("new Worker(name, safeJob(fn), { connection: redis(), ...opts })");
    expect(q).toMatch(/w\.on\("failed", \(job, err\) => logError\(/);
    expect(q).toMatch(/w\.on\("error", \(err\) => logError\(/);
    for (const [file, name] of [["keeper/keeper.ts", "Q.keeper"], ["notifier/notifier.ts", "Q.notify"], ["relayer/relayer.ts", "Q.relay"]] as const) {
      expect(read(...file.split("/"))).toMatch(new RegExp(`startWorker\\(\\s*${name.replace(".", "\\.")},`));
    }
  });

  test("startup and anything uncaught go through logError", () => {
    const idx = read("index.ts");
    expect(idx).toContain('process.on("unhandledRejection", (e) => logError("unhandled", e));');
    expect(idx).toMatch(/process\.on\("uncaughtException", \(e\) => \{\s*logError\("uncaught", e\);/);
    expect(idx).toMatch(/main\(\)\.catch\(\(err\) => \{\s*logError\("startup", err\);/);
    expect(read("indexer", "indexer.ts")).toContain('logError("indexer", e);');
  });
});
