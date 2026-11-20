/**
 * Monthly refresh of the IP data (run by the cofer-arena-geo timer):
 *   bun src/arena/geo/update.ts <dir>
 * Downloads this month's DB-IP Lite City and ASN files (last month's if this month's is not out yet) and the
 * hosting ASN list, checks each one opens and answers a known address, then swaps them in. On any failure the old
 * files stay in place and the exit code is 1, so the service keeps the last good data.
 */
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GEO_FILES, IpGeo } from "./ipgeo";

const DBIP = (kind: "city" | "asn", ym: string) => `https://download.db-ip.com/free/dbip-${kind}-lite-${ym}.mmdb.gz`;
const HOSTING = "https://raw.githubusercontent.com/brianhama/bad-asn-list/master/bad-asn-list.csv";

const ym = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

async function get(url: string): Promise<Uint8Array<ArrayBuffer>> {
  const r = await fetch(url, { headers: { "user-agent": "cofer-geo-update" }, signal: AbortSignal.timeout(600_000) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

async function dbip(kind: "city" | "asn", now: Date): Promise<{ buf: Buffer; month: string }> {
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  for (const m of [ym(now), ym(prev)]) {
    try {
      return { buf: Buffer.from(Bun.gunzipSync(await get(DBIP(kind, m)))), month: m };
    } catch (e) {
      console.log(`${kind} ${m}: ${(e as Error).message}`);
    }
  }
  throw new Error(`no DB-IP ${kind} file for ${ym(now)} or ${ym(prev)}`);
}

export async function update(dir: string, now = new Date()): Promise<string> {
  const city = await dbip("city", now);
  const asn = await dbip("asn", now);
  const hosting = new TextDecoder().decode(await get(HOSTING));
  const g = IpGeo.fromBuffers(city.buf, asn.buf, hosting);
  const probe = g.lookup("8.8.8.8");
  if (probe.country !== "US" || probe.asn !== 15169) throw new Error(`check failed: 8.8.8.8 gave ${JSON.stringify(probe)}`);
  if (g.hosting.size < 300) throw new Error(`hosting list too short: ${g.hosting.size}`);
  // Only the ASN numbers are kept (the list's entity names are not needed and are not stored).
  const asns = `ASN\n${[...g.hosting].sort((x, y) => x - y).join("\n")}\n`;
  const files: [string, Uint8Array | string][] = [[GEO_FILES.city, city.buf], [GEO_FILES.asn, asn.buf], [GEO_FILES.hosting, asns]];
  for (const [name, data] of files) writeFileSync(join(dir, `${name}.new`), data);
  for (const [name] of files) renameSync(join(dir, `${name}.new`), join(dir, name));
  return `city ${city.month}, asn ${asn.month}, hosting ASNs ${g.hosting.size}`;
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) (console.log("usage: bun src/arena/geo/update.ts <dir>"), process.exit(2));
  update(dir).then(
    (s) => console.log(`geo data updated: ${s}`),
    (e) => (console.log(`geo update FAILED: ${(e as Error).message}`), process.exit(1)),
  );
}
