import { describe, expect, test } from "bun:test";
import { type ArenaMode, type AsnClass, arenaGate, subdivisionOf } from "../src/core/geo";
import { loadRegionSettings, reviewOverdue } from "../src/arena/eligibility/regions";

const MODES: ArenaMode[] = ["PRACTICE", "FREEROLL", "FRIEND"];
const ASN: AsnClass[] = ["residential", "mobile", "hosting", "vpn", null];

describe("arena region gate", () => {
  test("every mode × network class from an allowed country", () => {
    for (const mode of MODES)
      for (const asnClass of ASN) {
        const g = arenaGate(mode, false, { declared: "NG", ipCountry: "NG", asnClass });
        const bad = asnClass === "hosting" || asnClass === "vpn";
        if (mode === "PRACTICE") expect(g).toEqual({ play: true, prize: false });
        if (mode === "FREEROLL") expect(g).toEqual(bad ? { play: true, prize: false, reason: "network" } : { play: true, prize: true });
        if (mode === "FRIEND") expect(g).toEqual(bad ? { play: false, prize: false, reason: "network" } : { play: true, prize: true });
      }
  });

  test("Friend Tables refuse hosting and VPN networks even with stocks off and a matching country", () => {
    for (const asnClass of ["hosting", "vpn"] as AsnClass[])
      for (const hasStocks of [false, true]) expect(arenaGate("FRIEND", hasStocks, { declared: "DE", ipCountry: "DE", asnClass })).toMatchObject({ play: false, reason: "network" });
  });

  test("sanctioned countries and subdivisions refuse every mode, on any network", () => {
    for (const mode of MODES)
      for (const asnClass of ASN) {
        for (const c of ["CU", "IR", "KP", "SY"]) {
          expect(arenaGate(mode, false, { declared: c, ipCountry: "NG", asnClass })).toEqual({ play: false, prize: false, reason: "region" });
          expect(arenaGate(mode, false, { declared: "NG", ipCountry: c, asnClass })).toEqual({ play: false, prize: false, reason: "region" });
        }
        for (const rc of ["43", "40", "14", "09"])
          expect(arenaGate(mode, false, { declared: "UA", ipCountry: "UA", ipRegion: subdivisionOf("UA", rc), asnClass })).toEqual({ play: false, prize: false, reason: "region" });
      }
    // the rest of Ukraine plays
    expect(arenaGate("FRIEND", false, { declared: "UA", ipCountry: "UA", ipRegion: subdivisionOf("UA", "30"), asnClass: "residential" })).toEqual({ play: true, prize: true });
  });

  test("subdivision codes from the edge", () => {
    expect(subdivisionOf("ua", "43")).toBe("UA-43");
    expect(subdivisionOf("UA", "UA-14")).toBe("UA-14");
    expect(subdivisionOf("UA", null)).toBeUndefined();
    expect(subdivisionOf(null, "43")).toBeUndefined();
  });

  test("the list comes from settings; a malformed setting refuses to load; the monthly review is tracked", () => {
    const d = loadRegionSettings({});
    expect([...d.countries].sort()).toEqual(["CU", "IR", "KP", "SY"]);
    expect([...d.subdivisions].sort()).toEqual(["UA-09", "UA-14", "UA-40", "UA-43"]);
    const s = loadRegionSettings({ ARENA_SANCTIONED: "cu, ir,KP,SY,RU", ARENA_SANCTIONED_REGIONS: "UA-43", ARENA_SANCTIONS_REVIEWED: "2026-11-19" });
    expect(s.countries.has("RU")).toBe(true);
    expect(s.subdivisions.has("UA-14")).toBe(false);
    expect(arenaGate("FREEROLL", false, { declared: "RU", ipCountry: "RU" }, s.countries, s.subdivisions).play).toBe(false);
    expect(() => loadRegionSettings({ ARENA_SANCTIONED: "CU,Iran" })).toThrow("not a valid code");
    expect(() => loadRegionSettings({ ARENA_SANCTIONED_REGIONS: "Crimea" })).toThrow("not a valid code");
    expect(() => loadRegionSettings({ ARENA_SANCTIONS_REVIEWED: "19/11/2026" })).toThrow("YYYY-MM-DD");
    const now = Date.parse("2026-12-15T00:00:00Z");
    expect(reviewOverdue(s, now)).toEqual({ overdue: false, days: 26 });
    expect(reviewOverdue(s, Date.parse("2026-12-21T00:00:00Z")).overdue).toBe(true);
    expect(reviewOverdue(d, now)).toEqual({ overdue: true, days: null });
  });
});
