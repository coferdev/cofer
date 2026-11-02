/**
 * Server health (keeper job "server", every minute): rpc-down, errors-spike, disk-low, memory-high.
 *
 * Shared state lives in Redis, because the bot, API, indexer and jobs can run as separate processes:
 *  - RPC_FAILING_KEY: when the chain RPC started failing (set on the first failed probe)
 *  - RPC_RECOVERED_KEY: set for RPC_GRACE_SEC after it answers again
 *  While either exists, alerts an RPC outage would cause anyway (indexer-behind, job-failing,
 *  errors-spike) are held back: one outage, one alert (rpc-down). Emergencies are never held back.
 *  After the grace period, a problem that still holds posts normally on its next check.
 *  - ERRORS_KEY_PREFIX + minute: errors logged in that minute, by every process (logError)
 *
 * Disk and memory are those of the server the keeper runs on.
 */
import { statfs } from "node:fs/promises";
import { freemem, totalmem } from "node:os";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client";
import { publicClient } from "../chain/clients";
import { redisClient } from "../queues";
import { logError } from "../core/errors";
import { WHO } from "../core/alertFormat";
import {
  diskLowProblem,
  errorsSpikeProblem,
  ERRORS_WINDOW_SEC,
  memoryHighProblem,
  nextHighSince,
  RPC_GRACE_SEC,
  rpcDownProblem,
} from "../core/serverHealth";
import { alertDeps, checkAlert, type AlertDeps } from "./alerts";

export const RPC_FAILING_KEY = "cofer:rpc:failing-since";
export const RPC_RECOVERED_KEY = "cofer:rpc:recovered";
export const ERRORS_KEY_PREFIX = "cofer:errors:";

export const RPC_DOWN_ALERT = "rpc-down";
export const ERRORS_SPIKE_ALERT = "errors-spike";
export const DISK_LOW_ALERT = "disk-low";
export const MEMORY_HIGH_ALERT = "memory-high";

/** Records one probe; returns when the RPC started failing (unix seconds), or null if it answers. */
export async function rpcMark(ok: boolean, now: number): Promise<number | null> {
  const r = redisClient();
  if (!ok) {
    await r.set(RPC_FAILING_KEY, String(now), "NX");
    return Number(await r.get(RPC_FAILING_KEY));
  }
  if ((await r.del(RPC_FAILING_KEY)) > 0) await r.set(RPC_RECOVERED_KEY, "1", "EX", RPC_GRACE_SEC);
  return null;
}

/** True while the RPC is failing, or within the grace period after it recovered. */
export async function rpcTrouble(): Promise<boolean> {
  return (await redisClient().exists(RPC_FAILING_KEY, RPC_RECOVERED_KEY)) > 0;
}

/** Counts one logged error (called by logError in every process). */
export async function recordError(nowSec = Math.floor(Date.now() / 1000)): Promise<void> {
  const key = `${ERRORS_KEY_PREFIX}${Math.floor(nowSec / 60)}`;
  await redisClient().multi().incr(key).expire(key, 15 * 60).exec();
}

/** Errors logged in the last ERRORS_WINDOW_SEC (whole minutes). */
export async function errorCount(nowSec: number): Promise<number> {
  const minute = Math.floor(nowSec / 60);
  const keys = Array.from({ length: ERRORS_WINDOW_SEC / 60 }, (_, i) => `${ERRORS_KEY_PREFIX}${minute - i}`);
  return (await redisClient().mget(...keys)).reduce((n, v) => n + Number(v ?? 0), 0);
}

/** Free fraction of the disk holding the working directory. */
export async function diskFree(path = process.cwd()): Promise<number> {
  const s = await statfs(path);
  return s.blocks > 0 ? s.bavail / s.blocks : 1;
}

/** Used fraction of memory: Linux MemAvailable when present (counts reclaimable cache as free), else the OS figure. */
export async function memoryUsed(): Promise<number> {
  try {
    const info = await Bun.file("/proc/meminfo").text();
    const kb = (name: string) => Number(info.match(new RegExp(`^${name}:\\s+(\\d+)`, "m"))?.[1]);
    const total = kb("MemTotal");
    const avail = kb("MemAvailable");
    if (total > 0 && avail >= 0) return 1 - avail / total;
  } catch {
    /* not Linux */
  }
  return 1 - freemem() / totalmem();
}

export interface ServerDeps {
  now(): number; // unix seconds
  probeRpc(): Promise<unknown>;
  rpcMark(ok: boolean, now: number): Promise<number | null>;
  errorCount(now: number): Promise<number>;
  diskFree(): Promise<number>;
  memoryUsed(): Promise<number>;
  isOpen(key: string): Promise<boolean>;
  /** When memory went above its limit without dropping back (kept between runs). */
  memory: { highSince: number | null };
  alerts: AlertDeps;
}

const memoryState = { highSince: null as number | null };

function serverDeps(): ServerDeps {
  return {
    now: () => Math.floor(Date.now() / 1000),
    probeRpc: () => publicClient().getBlockNumber({ cacheTime: 0 }),
    rpcMark,
    errorCount,
    diskFree: () => diskFree(),
    memoryUsed,
    isOpen: async (key) => (await db().query.alerts.findFirst({ where: eq(schema.alerts.key, key) })) !== undefined,
    memory: memoryState,
    alerts: alertDeps(),
  };
}

/** Runs each check on its own; one that cannot run is logged and the others still run. Never throws. */
export async function serverChecks(deps: ServerDeps = serverDeps()) {
  const now = deps.now();
  const out: Record<string, unknown> = {};
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      out[name] = await fn();
    } catch (e) {
      logError(`cofer-keeper server ${name}`, e);
      out[name] = null;
    }
  };

  await step("rpcOk", async () => {
    let ok = true;
    try {
      await deps.probeRpc();
    } catch {
      ok = false; // the failure itself is what this check reports; not logged as an error each minute
    }
    const since = await deps.rpcMark(ok, now);
    const p = rpcDownProblem(since, now);
    await checkAlert(
      RPC_DOWN_ALERT,
      p === null ? null : { name: RPC_DOWN_ALERT, what: p, who: "Dev checks the RPC provider, and switches RHC_RPC_URL if it stays down." },
      deps.alerts,
      "the chain RPC answers again",
    );
    return ok;
  });

  await step("errors", async () => {
    const n = await deps.errorCount(now);
    const p = errorsSpikeProblem(n, await deps.isOpen(ERRORS_SPIKE_ALERT));
    await checkAlert(ERRORS_SPIKE_ALERT, p === null ? null : { name: ERRORS_SPIKE_ALERT, what: p, who: "Dev checks the log.", rpcRelated: true }, deps.alerts);
    return n;
  });

  await step("diskFree", async () => {
    const free = await deps.diskFree();
    const p = diskLowProblem(free, await deps.isOpen(DISK_LOW_ALERT));
    await checkAlert(DISK_LOW_ALERT, p === null ? null : { name: DISK_LOW_ALERT, what: p, who: "Dev frees disk space on the server (old logs, old images) or adds disk." }, deps.alerts);
    return free;
  });

  await step("memoryUsed", async () => {
    const used = await deps.memoryUsed();
    deps.memory.highSince = nextHighSince(used, deps.memory.highSince, now);
    const p = memoryHighProblem(used, deps.memory.highSince, now, await deps.isOpen(MEMORY_HIGH_ALERT));
    await checkAlert(MEMORY_HIGH_ALERT, p === null ? null : { name: MEMORY_HIGH_ALERT, what: p, who: "Dev checks which process uses the memory, and restarts it or adds memory." }, deps.alerts);
    return used;
  });

  return out;
}
