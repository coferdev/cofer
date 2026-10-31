import { Queue, Worker, type ConnectionOptions, type Job, type WorkerOptions } from "bullmq";
import IORedis from "ioredis";
import { env } from "./env";
import { logError, safeJob } from "./core/errors";

let _conn: IORedis | undefined;
export function redis(): ConnectionOptions {
  _conn ??= new IORedis(env().REDIS_URL, { maxRetriesPerRequest: null });
  return _conn;
}

export const Q = { relay: "cofer-relay", notify: "cofer-notify", keeper: "cofer-keeper" } as const;

/**
 * Every background worker starts here. A failed job is stored in Redis (failedReason, stacktrace)
 * with URLs removed, and failures and worker errors are logged the same way. Retries are unchanged.
 */
export function startWorker(name: string, fn: (job: Job, token?: string) => Promise<unknown>, opts: Omit<WorkerOptions, "connection"> = {}): Worker {
  const w = new Worker(name, safeJob(fn), { connection: redis(), ...opts });
  w.on("failed", (job, err) => logError(`${name} ${job?.name ?? "?"}`, err));
  w.on("error", (err) => logError(name, err));
  return w;
}

/** True when a failed job will not be retried: its last attempt failed (BullMQ counts the attempt before "failed" fires). */
export function isFinalFailure(job: Pick<Job, "attemptsMade" | "opts">, err?: Error): boolean {
  if (err?.name === "UnrecoverableError") return true;
  return job.attemptsMade >= (job.opts.attempts ?? 1);
}

let _queues: { relay: Queue; notify: Queue; keeper: Queue } | undefined;
export function queues() {
  _queues ??= {
    relay: new Queue(Q.relay, { connection: redis(), defaultJobOptions: { attempts: 5, backoff: { type: "exponential", delay: 2000 }, removeOnComplete: 1000 } }),
    notify: new Queue(Q.notify, { connection: redis(), defaultJobOptions: { attempts: 3, removeOnComplete: 1000 } }),
    keeper: new Queue(Q.keeper, { connection: redis() }),
  };
  return _queues;
}

/** The relay job's ID: one per proposal and run time, so repeated adds of the same run are ignored. */
export const relayJobId = (proposalId: string, at?: number) => `relay:${proposalId}:${at ?? 0}`;

/** Relay as soon as possible (or at `at` for proposals waiting out their exit window). */
export async function enqueueRelay(proposalId: string, at?: number) {
  const delay = at ? Math.max(0, at * 1000 - Date.now()) : 0;
  await queues().relay.add("execute", { proposalId }, { jobId: relayJobId(proposalId, at), delay });
}

// The owner's setting: a relay job that failed all its tries is tried again (5 more) this long after.
export const RELAY_RETRY_AFTER_MS = 5 * 60_000;

export type SweepAction = "add" | "leave" | "retry-failed" | "retry-completed";

/**
 * What the sweep does with the relay job of a vote that should run now. Adding the same job ID
 * again is ignored while the queue still holds that job (kept forever once failed), so a stuck
 * job must be retried, never re-added. A job still waiting or running is left alone: two copies
 * of one vote could race and mark an executed vote failed.
 */
export function sweepAction(state: string | null, finishedOn: number | undefined, nowMs: number, retryAfterMs = RELAY_RETRY_AFTER_MS): SweepAction {
  if (state === null || state === "unknown") return "add";
  if (state !== "failed" && state !== "completed") return "leave";
  if (finishedOn !== undefined && nowMs - finishedOn < retryAfterMs) return "leave";
  return state === "failed" ? "retry-failed" : "retry-completed";
}

type RelayQueue = {
  getJob(id: string): Promise<{ finishedOn?: number; getState(): Promise<string>; retry(state: "failed" | "completed", opts: { resetAttemptsMade: boolean; resetAttemptsStarted: boolean }): Promise<void> } | undefined>;
};

/** Makes sure a vote that should run now has a live relay job (the sweep's backup for lost or stuck jobs). */
export async function ensureRelay(proposalId: string, at?: number, q: RelayQueue = queues().relay as unknown as RelayQueue, nowMs = Date.now()): Promise<SweepAction> {
  const job = await q.getJob(relayJobId(proposalId, at));
  const action = sweepAction(job ? await job.getState() : null, job?.finishedOn, nowMs);
  if (action === "add") await enqueueRelay(proposalId, at);
  else if (action === "retry-failed" || action === "retry-completed") {
    await job!.retry(action === "retry-failed" ? "failed" : "completed", { resetAttemptsMade: true, resetAttemptsStarted: true });
  }
  return action;
}

/** Coalesce bursts of updates for one proposal card into a single Telegram edit. */
export async function enqueueNotify(proposalId: string) {
  await queues().notify.add("card", { proposalId }, { jobId: `card:${proposalId}:${Math.floor(Date.now() / 3000)}`, delay: 1500 });
}

export async function enqueueChatMessage(chatId: number, text: string) {
  await queues().notify.add("text", { chatId, text });
}
