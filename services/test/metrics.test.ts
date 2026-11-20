import { describe, expect, test } from "bun:test";
import { createServer } from "../src/api/server";
import { parseEnv } from "../src/env";
import { isLocalRequest, metricsText, type MetricsSnapshot } from "../src/api/metrics";

const SNAP: MetricsSnapshot = {
  indexerLagSeconds: 12,
  indexerLagBlocks: 120,
  queues: { keeper: { waiting: 1, active: 0, delayed: 3, failed: 0 } },
  openAlerts: 2,
  feeds: [{ symbol: "USDG", ageSeconds: 600, limitSeconds: 86400 }],
  publicRequests: { "200": 40, "429": 1 },
};
const env = parseEnv({ PUBLIC_URL: "https://sign.example", DATABASE_URL: "postgres://unused", RHC_RPC_URL: "https://rpc.example", FACTORY_ADDRESS: "0x0000000000000000000000000000000000000001", ADAPTER_ADDRESS: "0x0000000000000000000000000000000000000002", RELAYER_PRIVATE_KEY: "0x01", TELEGRAM_BOT_TOKEN: "1:unused", TELEGRAM_BOT_USERNAME: "unused", TELEGRAM_WEBHOOK_SECRET: "w".repeat(24), LINK_SECRET: "l".repeat(32), BOT_MODE: "polling" });
const server = (remote: string | null) => createServer({ deps: {} as never, cards: null, signerJs: "", env, metrics: { snapshot: async () => SNAP, remoteAddress: () => remote } });

describe("GET /metrics", () => {
  test("Prometheus text: lag, queues, alerts, feed ages, request counts", () => {
    const t = metricsText(SNAP);
    for (const line of ["cofer_indexer_lag_seconds 12", "cofer_indexer_lag_blocks 120", 'cofer_queue_jobs{queue="keeper",state="delayed"} 3', "cofer_alerts_open 2", 'cofer_feed_age_seconds{feed="USDG"} 600', 'cofer_feed_limit_seconds{feed="USDG"} 86400', 'cofer_public_api_requests_total{status="429"} 1']) expect(t).toContain(line);
    expect(t).toContain("# TYPE cofer_alerts_open gauge");
    expect(t.endsWith("\n")).toBe(true);
  });

  test("answers on the server itself; anyone else, or anything through the proxy, gets 404", async () => {
    const ok = await server("127.0.0.1").request("/metrics");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
    expect((await server("203.0.113.9").request("/metrics")).status).toBe(404);
    expect((await server("127.0.0.1").request("/metrics", { headers: { "x-forwarded-for": "203.0.113.9" } })).status).toBe(404);
    expect((await server(null).request("/metrics")).status).toBe(404);
  });

  test("public API answers are counted by the server", async () => {
    const { fakePublicApi } = await import("./publicApiHarness");
    const app = createServer({ deps: {} as never, cards: null, signerJs: "", env, publicApi: fakePublicApi(), metrics: { snapshot: async () => ({ ...SNAP, publicRequests: {} }), remoteAddress: () => "127.0.0.1" } });
    await app.request("/v1/status");
    await app.request("/v1/nothing");
    const t = await (await app.request("/metrics")).text();
    expect(t).toContain('cofer_public_api_requests_total{status="200"} 1');
    expect(t).toContain('cofer_public_api_requests_total{status="404"} 1');
  });

  test("only loopback counts as local", () => {
    const h = new Headers();
    expect([isLocalRequest("127.0.0.1", h), isLocalRequest("::1", h), isLocalRequest("10.0.0.5", h), isLocalRequest("0.0.0.0", h)]).toEqual([true, true, false, false]);
  });
});
