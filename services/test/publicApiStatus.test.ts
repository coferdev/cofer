import { describe, expect, test } from "bun:test";
import { cached, jsonText } from "../src/publicapi/format";
import { clientKey, limiter } from "../src/publicapi/rateLimit";
import { feedState, readStatus } from "../src/publicapi/status";
import { publicApi } from "../src/publicapi/router";
import { fakePublicApi, fakeStatus, getJson, NOW, publicServer, TSLA } from "./publicApiHarness";

describe("GET /v1/status", () => {
  test("chain, head block, indexer lag, relayer and every feed, big numbers as strings", async () => {
    const r = await getJson(publicServer(), "/v1/status");
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({
      chainId: 4663,
      headBlock: "1000020",
      indexer: { state: "live", lastBlock: "1000000", targetBlock: "1000000", lagBlocks: "0", lagSeconds: 0, maxLagSeconds: 300 },
      relayer: { hasGas: true, daysLeft: 21.5 },
      feeds: [
        { symbol: "USDG", asset: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", state: "ok", ageSeconds: 600, limitSeconds: 86400 },
        { symbol: "TSLA", asset: TSLA, state: "near limit", ageSeconds: 345000, limitSeconds: 345600 },
      ],
    });
    expect(r.body.meta.chainId).toBe(4663);
    expect(r.body.meta.cacheSeconds).toBe(15);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(r.headers.get("cache-control")).toBe("public, max-age=15");
  });

  test("lag maths: blocks and seconds against head minus confirmations", async () => {
    const s = await readStatus(fakeStatus({ cursor: async () => 999_000n }));
    expect(s.indexer).toEqual({ state: "behind", lastBlock: 999_000n, targetBlock: 1_000_000n, lagBlocks: 1_000n, lagSeconds: 1_000, maxLagSeconds: 300 });
    const close = await readStatus(fakeStatus({ cursor: async () => 999_800n }));
    expect(close.indexer.state).toBe("live");
    expect(close.indexer.lagSeconds).toBe(200);
    const none = await readStatus(fakeStatus({ cursor: async () => null }));
    expect(none.indexer).toMatchObject({ state: "not started", lastBlock: null, lagBlocks: null, lagSeconds: null });
  });

  test("feed states: ok, near limit, past limit, bad", () => {
    const f = { symbol: "X", asset: "0x", answer: 1n, maxStaleness: 86_400 };
    expect(feedState({ ...f, updatedAt: NOW - 100 }, NOW)).toBe("ok");
    expect(feedState({ ...f, updatedAt: NOW - 86_000 }, NOW)).toBe("near limit");
    expect(feedState({ ...f, updatedAt: NOW - 86_401 }, NOW)).toBe("past limit");
    expect(feedState({ ...f, answer: 0n, updatedAt: NOW }, NOW)).toBe("bad");
    expect(feedState({ ...f, updatedAt: NOW + 5 }, NOW)).toBe("bad");
  });

  test("a relayer read that fails shows unknown, not an error", async () => {
    const s = await readStatus(fakeStatus({ relayerHasGas: async () => Promise.reject(new Error("rpc")) }));
    expect(s.relayer.hasGas).toBeNull();
  });

  test("a failed chain read answers 503 with fixed text and no detail", async () => {
    const app = publicServer(fakePublicApi({ status: fakeStatus({ head: async () => Promise.reject(new Error("https://secret-rpc.example/key123 failed")) }) }));
    const r = await getJson(app, "/v1/status");
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: { code: "unavailable", message: "Couldn't read the chain or the database just now. Try again in a minute." } });
    expect(JSON.stringify(r.body)).not.toContain("secret-rpc");
  });

  test("one shared read per 15 seconds, however many requests", async () => {
    let reads = 0;
    let t = 0;
    const api = publicApi({ ...fakePublicApi({ status: fakeStatus({ head: async () => (reads++, 1_000_020n) }) }), nowMs: () => t });
    await Promise.all(Array.from({ length: 20 }, () => api.app.request("/status")));
    expect(reads).toBe(1);
    t = 14_999;
    await api.app.request("/status");
    expect(reads).toBe(1);
    t = 15_000;
    await api.app.request("/status");
    expect(reads).toBe(2);
  });

  test("cached keeps no failure", async () => {
    let n = 0;
    const c = cached(async () => {
      if (n++ === 0) throw new Error("first fails");
      return 5;
    }, 1000, () => 0);
    await expect(c()).rejects.toThrow("first fails");
    expect((await c()).value).toBe(5);
  });
});

describe("the public API's rules", () => {
  test("per-IP rate limit: the 61st request in a minute gets 429 with Retry-After", async () => {
    const app = publicServer();
    for (let i = 0; i < 60; i++) expect((await app.request("/v1/status", { headers: { "x-forwarded-for": "203.0.113.7" } })).status).toBe(200);
    const r = await app.request("/v1/status", { headers: { "x-forwarded-for": "203.0.113.7" } });
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await r.json()).error.code).toBe("rate_limited");
    expect((await app.request("/v1/status", { headers: { "x-forwarded-for": "203.0.113.8" } })).status).toBe(200);
  });

  test("the client address is the proxy's last entry, so a client cannot pick its own", () => {
    expect(clientKey("1.1.1.1, 203.0.113.7")).toBe("203.0.113.7");
    expect(clientKey(undefined)).toBe("direct");
    expect(clientKey("not an ip")).toBe("direct");
  });

  test("an overall cap protects the server from many addresses at once", () => {
    const l = limiter({ max: 100, windowMs: 60_000 }, { max: 3, windowMs: 60_000 });
    expect([l.take("a", 0), l.take("b", 0), l.take("c", 0)]).toEqual([0, 0, 0]);
    expect(l.take("d", 0)).toBe(60_000);
    expect(l.take("d", 60_000)).toBe(0);
  });

  test("read-only: other methods get 405; OPTIONS answers CORS", async () => {
    const app = publicServer();
    expect((await app.request("/v1/status", { method: "POST" })).status).toBe(405);
    const o = await app.request("/v1/status", { method: "OPTIONS" });
    expect(o.status).toBe(204);
    expect(o.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
  });

  test("unknown routes answer 404 JSON; the rest of the server is unchanged", async () => {
    const app = publicServer();
    const r = await getJson(app, "/v1/nothing-here");
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("not_found");
    expect((await app.request("/healthz")).status).toBe(200);
  });

  test("bigints are written as decimal strings", () => {
    expect(jsonText({ a: 12345678901234567890123n })).toBe('{"a":"12345678901234567890123"}');
  });
});
