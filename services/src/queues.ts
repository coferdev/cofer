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
export function startWorker(name: string, fn: (job: Job) => Promise<unknown>, opts: Omit<WorkerOptions, "connection"> = {}): Worker {
  const w = new Worker(name, safeJob(fn), { connection: redis(), ...opts });
  w.on("failed", (job, err) => logError(`${name} ${job?.name ?? "?"}`, err));
  w.on("error", (err) => logError(name, err));
  return w;
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

/** Relay as soon as possible (or at `at` for proposals waiting out their exit window). */
export async function enqueueRelay(proposalId: string, at?: number) {
  const delay = at ? Math.max(0, at * 1000 - Date.now()) : 0;
  await queues().relay.add("execute", { proposalId }, { jobId: `relay:${proposalId}:${at ?? 0}`, delay });
}

/** Coalesce bursts of updates for one proposal card into a single Telegram edit. */
export async function enqueueNotify(proposalId: string) {
  await queues().notify.add("card", { proposalId }, { jobId: `card:${proposalId}:${Math.floor(Date.now() / 3000)}`, delay: 1500 });
}

export async function enqueueChatMessage(chatId: number, text: string) {
  await queues().notify.add("text", { chatId, text });
}
