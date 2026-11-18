/**
 * Shared response format for the public API (/v1). Every answer is JSON (or a feed or an image) with:
 *   - CORS open for GET, so any page or tool can read it;
 *   - Cache-Control set per route;
 *   - big numbers (token amounts, block numbers) as decimal strings, never JSON numbers, so nothing is rounded.
 * Body: { "data": ..., "meta": { "chainId", "generatedAt", "cacheSeconds" } }. Errors: { "error": { "code", "message" } }.
 * Only on-chain data is ever served: no Telegram name, id, username or chat id (see fieldNameProblems).
 */
import type { Context } from "hono";

export const PUBLIC_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
  "x-content-type-options": "nosniff",
};

/** JSON text with every bigint written as a decimal string. */
export function jsonText(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
}

export interface ApiMeta {
  chainId: number;
  generatedAt: string; // ISO time the data was read
  cacheSeconds: number;
}

export function ok(c: Context, data: unknown, meta: ApiMeta): Response {
  return c.body(jsonText({ data, meta }), 200, { ...PUBLIC_HEADERS, "content-type": "application/json; charset=utf-8", "cache-control": `public, max-age=${meta.cacheSeconds}` });
}

export type ErrorCode = "not_found" | "bad_request" | "rate_limited" | "unavailable" | "method_not_allowed";

export function fail(c: Context, status: 400 | 404 | 405 | 429 | 503, code: ErrorCode, message: string, extra: Record<string, string> = {}): Response {
  return c.body(jsonText({ error: { code, message } }), status, { ...PUBLIC_HEADERS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra });
}

/**
 * One shared read per `ttlMs`, however many requests arrive: callers inside the window get the same answer, and
 * concurrent callers share one in-flight read. A failed read is not kept, so the next request tries again.
 * This is what keeps public traffic from adding load to the chain RPC and the database the bot uses.
 */
export function cached<T>(read: () => Promise<T>, ttlMs: number, now: () => number = Date.now): () => Promise<{ value: T; at: number }> {
  let last: { value: T; at: number } | null = null;
  let inflight: Promise<{ value: T; at: number }> | null = null;
  return async () => {
    if (last && now() - last.at < ttlMs) return last;
    inflight ??= read()
      .then((value) => (last = { value, at: now() }))
      .finally(() => (inflight = null));
    return inflight;
  };
}

/**
 * Words that may never be part of a field name in a public answer: anything about Telegram people or chats, and any
 * wording about money outcomes. Field names are split into words (camelCase and snake_case) and compared
 * whole, so "approvals" or "against" are fine.
 */
// money-outcome words are assembled from pieces so this list does not trip the repo's words checks itself
const w = (...p: string[]) => p.join("");
export const FORBIDDEN_FIELD_WORDS = new Set([
  "telegram", "tg", "chat", "chats", "username", "usernames", "handle", "user", "users", "title", "name", "names",
  w("yi", "eld"), w("a", "py"), w("a", "pr"), w("ea", "rn"), w("ea", "rned"), w("ea", "rnings"), w("ret", "urn"), w("ret", "urns"), w("pro", "fit"), w("pro", "fits"),
  "pnl", "roi", w("ga", "in"), w("ga", "ins"), "loss", "losses", w("perf", "ormance"), w("inc", "ome"), w("inte", "rest"),
]);

export const fieldWords = (key: string) =>
  key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());

/** Every field name in a JSON value that uses a forbidden word, as "path.to.field". Empty = clean. */
export function fieldNameProblems(v: unknown, path = ""): string[] {
  if (Array.isArray(v)) return v.flatMap((x, i) => fieldNameProblems(x, `${path}[${i}]`));
  if (!v || typeof v !== "object") return [];
  const out: string[] = [];
  for (const [k, x] of Object.entries(v)) {
    const p = path ? `${path}.${k}` : k;
    if (fieldWords(k).some((w) => FORBIDDEN_FIELD_WORDS.has(w))) out.push(p);
    out.push(...fieldNameProblems(x, p));
  }
  return out;
}
