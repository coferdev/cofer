/**
 * "Backend down" switch. With HEALTHCHECK_PING_URL set (e.g. a healthchecks.io check), the keeper
 * pings it every 5 minutes while the backend is healthy, so the outside service alerts when the
 * pings stop (everything down) or when we report a failure (its "/fail" ping, at once).
 *
 * Healthy = the database answers, Redis works (this job ran from the queue), the chain RPC
 * answers, the indexer is within its limit (no open indexer alert), and the signer site's
 * /healthz answers at PUBLIC_URL. The ping URL is treated as a secret: never logged.
 */
import { sql, eq } from "drizzle-orm";
import { db, schema } from "../db/client";
import { publicClient } from "../chain/clients";
import { env } from "../env";
import { logError } from "../core/errors";
import { INDEXER_LAG_ALERT } from "../core/indexerLag";

// The owner's settings.
export const HEALTH_EVERY_MS = 300_000; // 5 minutes (suggested check: period 5 min, grace 10 min)
export const HEALTH_CHECK_TIMEOUT_MS = 15_000;

/** The URL to call: the base when healthy, its "/fail" form when not (healthchecks.io style). */
export function pingUrl(base: string, healthy: boolean): string {
  if (healthy) return base;
  const u = new URL(base);
  u.pathname = `${u.pathname.replace(/\/$/, "")}/fail`;
  return u.toString();
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<T>((_, reject) => (timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

export interface HealthDeps {
  url: string | undefined;
  checks: Record<string, () => Promise<unknown>>;
  /** Sends the ping with a short plain-text body (shown in the outside service's log). */
  ping(url: string, body: string): Promise<void>;
  timeoutMs?: number;
}

/** POSTs the ping. Any failure becomes a fixed error: a network error can quote the ping URL, which is a secret. */
export function pingSender(fetchImpl: typeof fetch = fetch): HealthDeps["ping"] {
  return async (url, body) => {
    let res: Response;
    try {
      res = await fetchImpl(url, { method: "POST", body, headers: { "content-type": "text/plain" }, signal: AbortSignal.timeout(10_000) });
    } catch {
      throw new Error("health ping: could not reach the ping service");
    }
    if (!res.ok) throw new Error(`health ping: the ping service answered ${res.status}`);
  };
}

function healthDeps(): HealthDeps {
  return {
    url: env().HEALTHCHECK_PING_URL,
    checks: {
      database: () => db().execute(sql`select 1`),
      chain: () => publicClient().getBlockNumber(),
      indexer: async () => {
        if (await db().query.alerts.findFirst({ where: eq(schema.alerts.key, INDEXER_LAG_ALERT) })) throw new Error("behind");
      },
      "signer site": async () => {
        const res = await fetch(new URL("/healthz", env().PUBLIC_URL), { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`status ${res.status}`);
      },
    },
    ping: pingSender(),
  };
}

/**
 * Runs every check, then pings: the base URL if all passed, "/fail" with the failed checks' names
 * if not. Never throws: a failed ping is logged (the outside service then alerts on its own).
 */
export async function healthPing(deps: HealthDeps = healthDeps()): Promise<{ healthy: boolean; failed: string[] } | "off"> {
  if (!deps.url) return "off";
  const failed: string[] = [];
  for (const [name, check] of Object.entries(deps.checks)) {
    try {
      await withTimeout(check(), deps.timeoutMs ?? HEALTH_CHECK_TIMEOUT_MS);
    } catch (e) {
      failed.push(name);
      logError(`cofer-keeper health ${name}`, e);
    }
  }
  const healthy = failed.length === 0;
  try {
    await deps.ping(pingUrl(deps.url, healthy), healthy ? "ok" : `failed: ${failed.join(", ")}`);
  } catch (e) {
    logError("cofer-keeper health", e);
  }
  return { healthy, failed };
}
