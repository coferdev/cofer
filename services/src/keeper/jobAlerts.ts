/**
 * Alert for a background job that keeps failing: the same job (queue + job name) failing on its
 * last attempt JOB_FAIL_ALERT_AFTER times in a row. One failure (a chain blip) never alerts. It
 * clears on that job's next success. Counts are per process and start again after a restart.
 * Relay jobs are not watched: a failing vote has its own alert (relayer/voteAlerts.ts).
 */
import type { Job, Worker } from "bullmq";
import { logError, redact } from "../core/errors";
import { isFinalFailure } from "../queues";
import { alertDeps, checkAlert, type AlertDeps } from "./alerts";

// The owner's setting.
export const JOB_FAIL_ALERT_AFTER = 3;

export const jobAlertKey = (queue: string, job: string) => `job-failing:${queue}:${job}`;

type Events = Pick<Worker, "name"> & {
  on(event: "failed", fn: (job: Job | undefined, err: Error) => void): unknown;
  on(event: "completed", fn: (job: Job) => void): unknown;
};

export function jobFailingText(queue: string, job: string, times: number, err: Error): string {
  const last = `${err.name}: ${redact(err.message)}`.slice(0, 200);
  return `Background job "${job}" (${queue}) has failed ${times} times in a row. Last error: ${last}. See the log for details.`;
}

/** Watches one worker's jobs and returns the per-job counts (for tests). */
export function watchJobFailures(w: Events, deps: AlertDeps = alertDeps(), threshold = JOB_FAIL_ALERT_AFTER) {
  const failures = new Map<string, number>();
  const seen = new Set<string>(); // a success clears once per process, so an alert left open before a restart still clears
  const report = (p: Promise<unknown>) => void p.catch((e) => logError("job alerts", e));

  w.on("failed", (job, err) => {
    if (!job || !isFinalFailure(job, err)) return; // a retry is still coming
    const n = (failures.get(job.name) ?? 0) + 1;
    failures.set(job.name, n);
    if (n >= threshold) report(checkAlert(jobAlertKey(w.name, job.name), jobFailingText(w.name, job.name, n, err), deps));
  });
  w.on("completed", (job) => {
    const had = failures.get(job.name) ?? 0;
    failures.delete(job.name);
    if (had === 0 && seen.has(job.name)) return;
    seen.add(job.name);
    report(checkAlert(jobAlertKey(w.name, job.name), null, deps, "it succeeded again"));
  });
  return failures;
}
