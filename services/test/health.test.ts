import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HEALTH_EVERY_MS, healthPing, pingSender, pingUrl, type HealthDeps } from "../src/keeper/health";
import { parseEnv } from "../src/env";

const URL_SECRET = "https://hc-ping.com/1f2e3d4c-SECRETUUID";

/** Runs the health job with the given checks; returns what was pinged and everything logged. */
async function run(checks: HealthDeps["checks"], ping?: HealthDeps["ping"], timeoutMs?: number) {
  const pings: { url: string; body: string }[] = [];
  const logged: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
  try {
    const r = await healthPing({ url: URL_SECRET, checks, ping: ping ?? (async (url, body) => void pings.push({ url, body })), timeoutMs });
    return { r, pings, logged: logged.join("\n") };
  } finally {
    console.error = orig;
  }
}
const ok = async () => {};
const down = (why: string) => async () => Promise.reject(new Error(why));

describe("the 'backend down' ping", () => {
  test("every 5 minutes", () => {
    expect(HEALTH_EVERY_MS).toBe(300_000);
  });

  test("not set: does nothing", async () => {
    let called = false;
    const r = await healthPing({ url: undefined, checks: { database: async () => (called = true) }, ping: async () => void (called = true) });
    expect(r).toBe("off");
    expect(called).toBe(false);
  });

  test("all healthy: pings the URL itself", async () => {
    const { r, pings } = await run({ database: ok, chain: ok, indexer: ok, "signer site": ok });
    expect(r).toEqual({ healthy: true, failed: [] });
    expect(pings).toEqual([{ url: URL_SECRET, body: "ok" }]);
  });

  test("a check fails: every check still runs, then '/fail' names the failed ones", async () => {
    const ran: string[] = [];
    const { r, pings, logged } = await run({
      database: async () => void ran.push("database"),
      chain: async () => {
        ran.push("chain");
        throw new Error(`fetch failed at https://rpc.example/RPCKEY`);
      },
      indexer: down("behind"),
      "signer site": async () => void ran.push("signer site"),
    });
    expect(ran).toEqual(["database", "chain", "signer site"]);
    expect(r).toEqual({ healthy: false, failed: ["chain", "indexer"] });
    expect(pings).toEqual([{ url: `${URL_SECRET}/fail`, body: "failed: chain, indexer" }]);
    expect(logged).not.toContain("RPCKEY");
  });

  test("a check that hangs counts as failed after the timeout", async () => {
    const { r } = await run({ database: () => new Promise(() => {}), chain: ok }, undefined, 20);
    expect(r).toEqual({ healthy: false, failed: ["database"] });
  });

  test("the '/fail' form keeps the rest of the URL", () => {
    expect(pingUrl(URL_SECRET, true)).toBe(URL_SECRET);
    expect(pingUrl(URL_SECRET, false)).toBe(`${URL_SECRET}/fail`);
    expect(pingUrl("https://hc-ping.com/key/cofer/", false)).toBe("https://hc-ping.com/key/cofer/fail");
    expect(pingUrl("https://example.com/ping/abc?rid=1", false)).toBe("https://example.com/ping/abc/fail?rid=1");
  });
});

describe("the ping URL is never logged", () => {
  test("ping service unreachable (with the URL in the network error): a fixed message", async () => {
    const send = pingSender((async () => {
      throw new Error(`Unable to connect to ${URL_SECRET}`);
    }) as unknown as typeof fetch);
    const { r, logged } = await run({ database: ok }, send);
    expect(r).toEqual({ healthy: true, failed: [] }); // never throws
    expect(logged).toContain("health ping: could not reach the ping service");
    expect(logged).not.toContain("SECRETUUID");
    expect(logged).not.toContain("hc-ping");
  });

  test("ping service answers with an error status: the status only", async () => {
    const send = pingSender((async () => new Response("nope", { status: 404 })) as unknown as typeof fetch);
    const { logged } = await run({ database: ok }, send);
    expect(logged).toContain("health ping: the ping service answered 404");
    expect(logged).not.toContain("SECRETUUID");
  });

  test("a good ping is a POST with the short text body", async () => {
    const seen: { url: string; method?: string; body?: unknown }[] = [];
    const send = pingSender((async (url: string, init?: RequestInit) => {
      seen.push({ url: String(url), method: init?.method, body: init?.body });
      return new Response("OK");
    }) as unknown as typeof fetch);
    await run({ database: down("x") }, send);
    expect(seen).toEqual([{ url: `${URL_SECRET}/fail`, method: "POST", body: "failed: database" }]);
  });
});

describe("setting and wiring", () => {
  test("HEALTHCHECK_PING_URL is optional and must be a URL", () => {
    const base = {
      PUBLIC_URL: "https://sign.example",
      DATABASE_URL: "postgres://x",
      RHC_RPC_URL: "https://rpc.example",
      FACTORY_ADDRESS: `0x${"1".repeat(40)}`,
      ADAPTER_ADDRESS: `0x${"2".repeat(40)}`,
      RELAYER_PRIVATE_KEY: "0x01",
      TELEGRAM_BOT_TOKEN: "t",
      TELEGRAM_BOT_USERNAME: "b",
      TELEGRAM_WEBHOOK_SECRET: "s".repeat(16),
      LINK_SECRET: "l".repeat(32),
    };
    expect(parseEnv(base).HEALTHCHECK_PING_URL).toBeUndefined();
    expect(parseEnv({ ...base, HEALTHCHECK_PING_URL: URL_SECRET }).HEALTHCHECK_PING_URL).toBe(URL_SECRET);
    expect(() => parseEnv({ ...base, HEALTHCHECK_PING_URL: "not a url" })).toThrow();
  });

  test("the keeper schedules it, and the real checks are the database, chain, indexer and signer site", () => {
    const src = (f: string) => readFileSync(join(import.meta.dir, "..", "src", "keeper", f), "utf8");
    expect(src("keeper.ts")).toContain('await q.upsertJobScheduler("health", { every: HEALTH_EVERY_MS }, { name: "health" });');
    expect(src("keeper.ts")).toContain('case "health":\n          return healthPing();');
    const health = src("health.ts");
    for (const name of ["database:", "chain:", "indexer:", '"signer site":']) expect(health).toContain(name);
    expect(health).toContain('new URL("/healthz", env().PUBLIC_URL)');
    expect(health).toContain("where: eq(schema.alerts.key, INDEXER_LAG_ALERT)");
  });
});
