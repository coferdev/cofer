/** The live numbers behind /metrics: the public API's status read, the job queues, the alerts table. */
import { count } from "drizzle-orm";
import { db, schema } from "../db/client";
import { queues } from "../queues";
import { readStatus } from "../publicapi/status";
import type { PublicApiDeps } from "../publicapi/router";
import type { MetricsDeps } from "./metrics";

export function liveMetricsDeps(api: PublicApiDeps): MetricsDeps {
  const out: MetricsDeps = {
    async snapshot() {
      const s = await readStatus(api.status).catch(() => null);
      const qs: Record<string, { waiting: number; active: number; delayed: number; failed: number }> = {};
      for (const [name, q] of Object.entries(queues())) {
        const c = await q.getJobCounts("waiting", "active", "delayed", "failed").catch(() => null);
        if (c) qs[name] = { waiting: c.waiting ?? 0, active: c.active ?? 0, delayed: c.delayed ?? 0, failed: c.failed ?? 0 };
      }
      const alerts = await db().select({ n: count() }).from(schema.alerts).catch(() => [{ n: 0 }]);
      return {
        indexerLagSeconds: s?.indexer.lagSeconds ?? null,
        indexerLagBlocks: s?.indexer.lagBlocks === null || s?.indexer.lagBlocks === undefined ? null : Number(s.indexer.lagBlocks),
        queues: qs,
        openAlerts: Number(alerts[0]?.n ?? 0),
        feeds: (s?.feeds ?? []).map((f) => ({ symbol: f.symbol, ageSeconds: f.ageSeconds, limitSeconds: f.limitSeconds })),
        publicRequests: {}, // filled in by the server, which counts them
      };
    },
  };
  return out;
}
