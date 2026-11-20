/**
 * cofer-ops status: the services' state on the server, in one screen. It never prints a secret: settings are listed by
 * name as set or not set, never with their values.
 *   - roles running (systemd units), the release folder in use and when it was deployed;
 *   - indexer lag, background queue sizes, open staff alerts;
 *   - which settings are set.
 */
import { lstatSync, readlinkSync } from "node:fs";
import { basename } from "node:path";

export interface StatusInput {
  units: { name: string; active: string }[]; // systemctl is-active per unit
  release: { folder: string; deployedAt: Date } | null; // what <releases>/current points at
  indexer: { lastBlock: bigint | null; targetBlock: bigint | null; lagSeconds: number | null } | null;
  queues: Record<string, { waiting: number; active: number; delayed: number; failed: number }> | null;
  alerts: string[] | null; // open alert keys
  settings: { name: string; set: boolean }[];
}

/** Setting names whose values are secrets: listed like every other one, as set or not set, and never read further. */
export const SECRET_SETTINGS = new Set(["RELAYER_PRIVATE_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "LINK_SECRET", "ALERT_BOT_TOKEN", "TEAMBOT_GITHUB_TOKEN", "CARD_PROVIDER_KEY", "HEALTHCHECK_PING_URL", "DATABASE_URL", "RHC_RPC_URL", "BUNDLER_URL", "PAYMASTER_URL"]);

const when = (d: Date) => `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;

export function statusReport(s: StatusInput): string {
  const lines: string[] = ["cofer-ops status", ""];
  lines.push("Roles:");
  for (const u of s.units) lines.push(`  ${u.name.padEnd(18)} ${u.active}`);
  if (!s.units.length) lines.push("  (no units given)");
  lines.push("", `Release:  ${s.release ? `${s.release.folder} (deployed ${when(s.release.deployedAt)})` : "no current release folder found"}`);
  const ix = s.indexer;
  lines.push(`Indexer:  ${!ix ? "could not be read" : ix.lastBlock === null ? "has not saved a block yet" : `block ${ix.lastBlock} of ${ix.targetBlock ?? "?"}, ${ix.lagSeconds === null ? "lag unknown" : `${ix.lagSeconds} s behind`}`}`);
  lines.push("Queues:");
  if (!s.queues) lines.push("  could not be read");
  else for (const [q, c] of Object.entries(s.queues)) lines.push(`  ${q.padEnd(10)} waiting ${c.waiting}  active ${c.active}  delayed ${c.delayed}  failed ${c.failed}`);
  lines.push(`Alerts:   ${!s.alerts ? "could not be read" : s.alerts.length ? `${s.alerts.length} open: ${s.alerts.join(", ")}` : "none open"}`);
  lines.push("", "Settings (names only, never values):");
  const set = s.settings.filter((x) => x.set).map((x) => x.name);
  const unset = s.settings.filter((x) => !x.set).map((x) => x.name);
  lines.push(`  set:     ${set.join(", ") || "none"}`, `  not set: ${unset.join(", ") || "none"}`);
  return lines.join("\n");
}

/** The release folder `current` points at, and when that link was made (the deploy time). */
export function currentRelease(releasesRoot: string): { folder: string; deployedAt: Date } | null {
  try {
    const link = `${releasesRoot.replace(/\/$/, "")}/current`;
    return { folder: basename(readlinkSync(link)), deployedAt: lstatSync(link).mtime };
  } catch {
    return null;
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (k: string, d: string) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? (argv[i + 1] ?? d) : d;
  };
  const units = flag("units", "cofer").split(",").filter(Boolean);
  const releases = flag("releases", "/srv/cofer-releases/testnet");
  const unitState = units.map((name) => {
    try {
      return { name, active: Bun.spawnSync(["systemctl", "is-active", name]).stdout.toString().trim() || "unknown" };
    } catch {
      return { name, active: "unknown (no systemctl here)" };
    }
  });
  const { schemaKeys } = await import("./settings");
  const settings = schemaKeys().map((name) => ({ name, set: !!process.env[name] }));
  let indexer: StatusInput["indexer"] = null;
  let queues: StatusInput["queues"] = null;
  let alerts: StatusInput["alerts"] = null;
  try {
    const { db, schema } = await import("../../src/db/client");
    const { eq } = await import("drizzle-orm");
    const { CURSOR } = await import("../../src/indexer/indexer");
    const { publicClient } = await import("../../src/chain/clients");
    const { env } = await import("../../src/env");
    const cursor = (await db().query.cursors.findFirst({ where: eq(schema.cursors.name, CURSOR) }))?.block ?? null;
    const target = (await publicClient().getBlockNumber()) - BigInt(env().CONFIRMATIONS);
    let lag: number | null = null;
    if (cursor !== null) {
      const [a, b] = await Promise.all([publicClient().getBlock({ blockNumber: target }), publicClient().getBlock({ blockNumber: cursor < target ? cursor : target })]);
      lag = Math.max(0, Number(a.timestamp - b.timestamp));
    }
    indexer = { lastBlock: cursor, targetBlock: target, lagSeconds: lag };
    alerts = (await db().select({ key: schema.alerts.key }).from(schema.alerts)).map((r) => r.key);
    const { queues: q } = await import("../../src/queues");
    queues = {};
    for (const [name, qq] of Object.entries(q())) {
      const c = await qq.getJobCounts("waiting", "active", "delayed", "failed");
      queues[name] = { waiting: c.waiting ?? 0, active: c.active ?? 0, delayed: c.delayed ?? 0, failed: c.failed ?? 0 };
    }
  } catch (e) {
    console.error(`(some parts could not be read: ${(e as Error).name})`);
  }
  console.log(statusReport({ units: unitState, release: currentRelease(releases), indexer, queues, alerts, settings }));
  process.exit(0);
}
