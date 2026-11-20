import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { arenaGate } from "../src/core/geo";
import { IpGeo, type Lookup, parseHostingList } from "../src/arena/geo/ipgeo";

const city: Record<string, unknown> = {
  "1.1.1.1": { country: { iso_code: "DE" }, subdivisions: [{ names: { en: "Bavaria" } }], city: { names: { en: "Munich" } } },
  "2.2.2.2": { country: { iso_code: "UA" }, subdivisions: [{ names: { en: "Crimea" } }], city: { names: { en: "Simferopol" } } },
  "3.3.3.3": { country: { iso_code: "RU" }, subdivisions: [{ names: { en: "Sevastopol" } }] },
  "4.4.4.4": { country: { iso_code: "UA" }, subdivisions: [{ names: { en: "Donetsk Oblast" } }] },
  "5.5.5.5": { country: { iso_code: "UA" }, subdivisions: [], city: { names: { en: "Luhansk (Lenins'kyi district)" } } },
  "6.6.6.6": { country: { iso_code: "UA" }, subdivisions: [{ names: { en: "Kyiv City" } }], city: { names: { en: "Kyiv" } } },
  "7.7.7.7": { country: { iso_code: "US" }, subdivisions: [{ names: { en: "Donetsk" } }] }, // only UA / RU names count
};
const asn: Record<string, unknown> = { "1.1.1.1": { autonomous_system_number: 3320 }, "6.6.6.6": { autonomous_system_number: 16509 } };
const L = (m: Record<string, unknown>): Lookup => ({ get: (ip) => m[ip] ?? null });
const geo = new IpGeo(L(city), L(asn), parseHostingList('ASN,Entity\n16509,"Amazon"\n14061,"DigitalOcean, LLC"\nbad,row\n'));

describe("IP lookup", () => {
  test("country, sanctioned region by name, hosting network by ASN", () => {
    expect(geo.lookup("1.1.1.1")).toEqual({ country: "DE", region: null, asn: 3320, asnClass: null });
    expect(geo.lookup("2.2.2.2").region).toBe("UA-43");
    expect(geo.lookup("3.3.3.3").region).toBe("UA-40");
    expect(geo.lookup("4.4.4.4").region).toBe("UA-14");
    expect(geo.lookup("5.5.5.5").region).toBe("UA-09");
    expect(geo.lookup("6.6.6.6")).toEqual({ country: "UA", region: null, asn: 16509, asnClass: "hosting" });
    expect(geo.lookup("7.7.7.7").region).toBeNull();
    expect(geo.lookup("9.9.9.9")).toEqual({ country: null, region: null, asn: null, asnClass: null });
    expect([...geo.hosting].sort()).toEqual([14061, 16509]);
  });

  test("what the lookup gives is what the gate refuses", () => {
    const at = (ip: string) => {
      const g = geo.lookup(ip);
      return arenaGate("FRIEND", false, { declared: g.country, ipCountry: g.country, ipRegion: g.region, asnClass: g.asnClass });
    };
    expect(at("1.1.1.1")).toEqual({ play: true, prize: true });
    expect(at("2.2.2.2")).toMatchObject({ play: false, reason: "region" });
    expect(at("6.6.6.6")).toMatchObject({ play: false, reason: "network" });
  });

  const dir = process.env.GEO_TEST_DIR;
  test.skipIf(!dir || !existsSync(`${dir}/dbip-city-lite.mmdb`))("the real DB-IP files (GEO_TEST_DIR)", () => {
    const real = IpGeo.load(dir!);
    expect(real.lookup("8.8.8.8")).toMatchObject({ country: "US", asn: 15169 });
    expect(real.lookup("193.0.6.139")).toMatchObject({ country: "NL", asn: 3333 });
    expect(real.hosting.size).toBeGreaterThan(500);
  });
});
