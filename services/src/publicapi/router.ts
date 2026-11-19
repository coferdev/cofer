/**
 * The public API, mounted at /v1 on the signer server (owner's decision: no separate address). Read-only: GET only,
 * no sign-in, no keys, per-IP rate limited (rateLimit.ts), CORS open for GET. Only on-chain data, never anything
 * from Telegram. A failed chain or database read answers 503 with fixed text; the error is logged without URLs.
 */
import { Hono } from "hono";
import { logError } from "../core/errors";
import { badgeSvg, type BadgeState } from "./badge";
import { cached, fail, ok, PUBLIC_HEADERS } from "./format";
import { clientKey, limiter, type Limiter } from "./rateLimit";
import { readStatus, STATUS_CACHE_MS, type Status, type StatusDeps } from "./status";

export interface PublicApiDeps {
  chainId: number;
  status: StatusDeps;
  limiter?: Limiter;
  nowMs?: () => number;
}

export const TEXT = {
  notFound: "Not found. The public API is read-only; see docs/api/README.md for its routes.",
  method: "Only GET is allowed.",
  limited: "Too many requests. Wait a little and try again.",
  down: "Couldn't read the chain or the database just now. Try again in a minute.",
} as const;

export function publicApi(d: PublicApiDeps) {
  const nowMs = d.nowMs ?? Date.now;
  const lim = d.limiter ?? limiter();
  const status = cached<Status>(() => readStatus(d.status), STATUS_CACHE_MS, nowMs);
  const meta = (at: number, cacheSeconds: number) => ({ chainId: d.chainId, generatedAt: new Date(at).toISOString(), cacheSeconds });
  const app = new Hono();

  app.onError((err, c) => {
    logError("publicapi", err);
    return fail(c, 503, "unavailable", TEXT.down);
  });

  app.use("*", async (c, next) => {
    if (c.req.method === "OPTIONS") return c.body(null, 204, PUBLIC_HEADERS);
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return fail(c, 405, "method_not_allowed", TEXT.method, { allow: "GET, OPTIONS" });
    const wait = lim.take(clientKey(c.req.header("x-forwarded-for")), nowMs());
    if (wait > 0) return fail(c, 429, "rate_limited", TEXT.limited, { "retry-after": String(Math.ceil(wait / 1000)) });
    await next();
  });

  app.get("/status", async (c) => {
    const s = await status();
    return ok(c, s.value, meta(s.at, STATUS_CACHE_MS / 1000));
  });

  // a status image for READMEs: never an error image; when the chain cannot be read it says "unknown"
  app.get("/badge.svg", async (c) => {
    let state: BadgeState = "unknown";
    try {
      state = (await status()).value.indexer.state;
    } catch (e) {
      logError("publicapi badge", e);
    }
    return c.body(badgeSvg(d.chainId, state), 200, { ...PUBLIC_HEADERS, "content-type": "image/svg+xml; charset=utf-8", "cache-control": `public, max-age=${STATUS_CACHE_MS / 1000}`, "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" });
  });

  // last: anything else under /v1 (a sub-app's notFound is not used once it is mounted)
  app.all("*", (c) => fail(c, 404, "not_found", TEXT.notFound));
  return { app, status };
}
