/**
 * Per-IP rate limit for the public API, kept in this process's memory: it never touches Redis or the database, so
 * public traffic cannot slow the bot, the indexer or the dashboard. Two windows of one minute each: one per client
 * address and one for all clients together. Over either, the answer is 429 with Retry-After.
 *
 * The client address: the last entry of X-Forwarded-For, which the server's own reverse proxy (Caddy) appends, so a
 * client cannot choose it by sending its own header; without the header (a direct local call), "direct".
 */

// The owner's settings.
export const PER_IP = { max: 60, windowMs: 60_000 };
export const ALL_CLIENTS = { max: 1200, windowMs: 60_000 };
export const MAX_TRACKED = 50_000; // client addresses kept at most (the oldest window is dropped first)

export function clientKey(forwardedFor: string | undefined | null): string {
  const last = (forwardedFor ?? "").split(",").map((s) => s.trim()).filter(Boolean).at(-1);
  return last && /^[0-9a-fA-F:.]{2,45}$/.test(last) ? last : "direct";
}

export interface Limiter {
  /** 0 when the request may go ahead, else the milliseconds until it may. */
  take(key: string, nowMs: number): number;
}

export function limiter(per = PER_IP, all = ALL_CLIENTS, maxTracked = MAX_TRACKED): Limiter {
  const hits = new Map<string, { start: number; count: number }>();
  let global = { start: 0, count: 0 };
  return {
    take(key, nowMs) {
      if (nowMs - global.start >= all.windowMs) global = { start: nowMs, count: 0 };
      if (global.count >= all.max) return Math.max(1, global.start + all.windowMs - nowMs);
      let h = hits.get(key);
      if (!h || nowMs - h.start >= per.windowMs) {
        hits.delete(key);
        if (hits.size >= maxTracked) hits.delete(hits.keys().next().value!);
        h = { start: nowMs, count: 0 };
        hits.set(key, h);
      }
      if (h.count >= per.max) return Math.max(1, h.start + per.windowMs - nowMs);
      h.count++;
      global.count++;
      return 0;
    },
  };
}
