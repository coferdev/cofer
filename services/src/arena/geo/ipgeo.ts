/**
 * IP to country, region and network class for the region gate (spec §11), best effort:
 *   - country and region: DB-IP "IP to City Lite" (CC BY 4.0; the site credits DB-IP)
 *   - network (ASN): DB-IP "IP to ASN Lite" (CC BY 4.0)
 *   - hosting and data-centre networks: brianhama/bad-asn-list (MIT), matched by ASN
 * The files live in one folder on the server and are replaced monthly by update.ts. Lookups are local, so no
 * player IP leaves the server, and raw IPs are never stored (geo_checks keeps country and ASN only).
 *
 * DB-IP Lite names regions in words, not ISO codes, so the sanctioned regions are matched by name. Areas under
 * occupation are often listed under another country by these databases, so this is a best-effort block.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Reader, type Response } from "mmdb-lib";
import type { AsnClass } from "../../core/geo";

export const GEO_FILES = { city: "dbip-city-lite.mmdb", asn: "dbip-asn-lite.mmdb", hosting: "bad-asn-list.csv" } as const;

/** Region and city names (lower case, district suffix removed) that map to a sanctioned ISO 3166-2 subdivision. */
export const REGION_NAMES: Record<string, string> = {
  crimea: "UA-43", "autonomous republic of crimea": "UA-43", "republic of crimea": "UA-43", krym: "UA-43", "avtonomna respublika krym": "UA-43",
  sevastopol: "UA-40", "sevastopol'": "UA-40", "sevastopol city": "UA-40",
  donetsk: "UA-14", "donetsk oblast": "UA-14", "donets'ka oblast'": "UA-14", "donetska oblast": "UA-14", "donetsk people's republic": "UA-14",
  luhansk: "UA-09", lugansk: "UA-09", "luhansk oblast": "UA-09", "luhans'ka oblast'": "UA-09", "luhanska oblast": "UA-09", "lugansk people's republic": "UA-09",
};
/** Countries a database may list those areas under. */
const REGION_COUNTRIES = new Set(["UA", "RU"]);

export interface IpInfo {
  country: string | null;
  /** ISO 3166-2 code, only when the place is one of REGION_NAMES (the gate needs nothing else). */
  region: string | null;
  asn: number | null;
  asnClass: AsnClass;
}

const norm = (s: unknown) => (typeof s === "string" ? s.replace(/\s*\(.*\)\s*$/, "").trim().toLowerCase() : "");

export function parseHostingList(csv: string): Set<number> {
  const out = new Set<number>();
  for (const line of csv.split(/\r?\n/).slice(1)) {
    const n = Number(line.split(",")[0]);
    if (Number.isInteger(n) && n > 0) out.add(n);
  }
  return out;
}

type CityRec = { country?: { iso_code?: string }; subdivisions?: { names?: { en?: string } }[]; city?: { names?: { en?: string } } };
type AsnRec = { autonomous_system_number?: number };
/** What IpGeo needs from a database (an mmdb Reader, or a stand-in under test). */
export interface Lookup {
  get(ip: string): unknown;
}

export class IpGeo {
  constructor(private readonly city: Lookup, private readonly asn: Lookup, readonly hosting: ReadonlySet<number>) {}

  static fromBuffers(city: Buffer, asn: Buffer, hostingCsv: string): IpGeo {
    return new IpGeo(new Reader<Response>(city), new Reader<Response>(asn), parseHostingList(hostingCsv));
  }

  static load(dir: string): IpGeo {
    for (const f of Object.values(GEO_FILES)) if (!existsSync(join(dir, f))) throw new Error(`geo data missing: ${join(dir, f)}`);
    return IpGeo.fromBuffers(readFileSync(join(dir, GEO_FILES.city)), readFileSync(join(dir, GEO_FILES.asn)), readFileSync(join(dir, GEO_FILES.hosting), "utf8"));
  }

  lookup(ip: string): IpInfo {
    let c: CityRec | null = null;
    let a: AsnRec | null = null;
    try {
      c = this.city.get(ip) as CityRec | null;
      a = this.asn.get(ip) as AsnRec | null;
    } catch {
      return { country: null, region: null, asn: null, asnClass: null };
    }
    const country = c?.country?.iso_code?.toUpperCase() ?? null;
    let region: string | null = null;
    if (country && REGION_COUNTRIES.has(country))
      for (const n of [...(c?.subdivisions ?? []).map((s) => s.names?.en), c?.city?.names?.en]) {
        const hit = REGION_NAMES[norm(n)];
        if (hit) {
          region = hit;
          break;
        }
      }
    const asn = a?.autonomous_system_number ?? null;
    return { country, region, asn, asnClass: asn !== null && this.hosting.has(asn) ? "hosting" : null };
  }
}
