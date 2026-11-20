/**
 * GET /metrics: numbers for monitoring tools, in the Prometheus text format: indexer lag, background queue sizes,
 * open alerts, price feed ages, and public API requests. It answers only on the server itself: a request from
 * anywhere else, or one passed on by the reverse proxy (it carries X-Forwarded-For), gets 404 as if it did not exist.
 */

export interface MetricsSnapshot {
  indexerLagSeconds: number | null;
  indexerLagBlocks: number | null;
  queues: Record<string, { waiting: number; active: number; delayed: number; failed: number }>;
  openAlerts: number;
  feeds: { symbol: string; ageSeconds: number; limitSeconds: number }[];
  publicRequests: Record<string, number>; // by answer status
}

export interface MetricsDeps {
  snapshot(): Promise<MetricsSnapshot>;
}

const LOCAL = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** True only for a request made on the server itself, not through the reverse proxy. */
export function isLocalRequest(remoteAddress: string | null | undefined, headers: { get(name: string): string | null }): boolean {
  if (headers.get("x-forwarded-for") || headers.get("x-real-ip") || headers.get("forwarded")) return false;
  return !!remoteAddress && LOCAL.has(remoteAddress);
}

const label = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");

export function metricsText(m: MetricsSnapshot): string {
  const out: string[] = [];
  const gauge = (name: string, help: string, rows: [Record<string, string>, number | null][]) => {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
    for (const [labels, v] of rows) {
      if (v === null) continue;
      const l = Object.entries(labels).map(([k, x]) => `${k}="${label(x)}"`).join(",");
      out.push(`${name}${l ? `{${l}}` : ""} ${v}`);
    }
  };
  gauge("cofer_indexer_lag_seconds", "How far the indexer is behind the chain, in chain time.", [[{}, m.indexerLagSeconds]]);
  gauge("cofer_indexer_lag_blocks", "How far the indexer is behind the chain, in blocks.", [[{}, m.indexerLagBlocks]]);
  gauge("cofer_queue_jobs", "Background jobs per queue and state.", Object.entries(m.queues).flatMap(([q, c]) => (["waiting", "active", "delayed", "failed"] as const).map((s) => [{ queue: q, state: s }, c[s]] as [Record<string, string>, number])));
  gauge("cofer_alerts_open", "Staff alerts open now.", [[{}, m.openAlerts]]);
  gauge("cofer_feed_age_seconds", "Age of each price feed's latest answer.", m.feeds.map((f) => [{ feed: f.symbol }, f.ageSeconds]));
  gauge("cofer_feed_limit_seconds", "Each price feed's age limit (the factory's maxStaleness).", m.feeds.map((f) => [{ feed: f.symbol }, f.limitSeconds]));
  out.push("# HELP cofer_public_api_requests_total Public API requests since start, by answer status.", "# TYPE cofer_public_api_requests_total counter");
  for (const [status, n] of Object.entries(m.publicRequests)) out.push(`cofer_public_api_requests_total{status="${label(status)}"} ${n}`);
  return `${out.join("\n")}\n`;
}
