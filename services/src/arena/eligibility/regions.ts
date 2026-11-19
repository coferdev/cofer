/**
 * The sanctioned list for the region gate (spec §11), loaded from settings and reviewed monthly:
 *   ARENA_SANCTIONED=CU,IR,KP,SY                         ISO 3166-1 alpha-2 countries
 *   ARENA_SANCTIONED_REGIONS=UA-43,UA-40,UA-14,UA-09     ISO 3166-2 subdivisions, matched against the edge IP region
 *   ARENA_SANCTIONS_REVIEWED=2026-11-19                  the date of the last review
 * A setting that is present but malformed stops the signer from starting rather than signing on a wrong list.
 * A missing setting uses the defaults below. A review older than 31 days is reported (status page and alarm), and
 * the signer keeps refusing the listed places in the meantime.
 */
import { SANCTIONED_DEFAULT, SANCTIONED_REGIONS_DEFAULT } from "../../core/geo";

export interface RegionSettings {
  countries: ReadonlySet<string>;
  subdivisions: ReadonlySet<string>;
  reviewed: string | null; // YYYY-MM-DD
}

export const REVIEW_EVERY_DAYS = 31;

export const defaultRegionSettings: RegionSettings = { countries: SANCTIONED_DEFAULT, subdivisions: SANCTIONED_REGIONS_DEFAULT, reviewed: null };

function codes(name: string, v: string | undefined, re: RegExp, fallback: ReadonlySet<string>): ReadonlySet<string> {
  if (v === undefined || v.trim() === "") return fallback;
  const out = v.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const bad = out.filter((c) => !re.test(c));
  if (bad.length) throw new Error(`${name}: not a valid code: ${bad.join(", ")}`);
  return new Set(out);
}

export function loadRegionSettings(env: Record<string, string | undefined> = process.env): RegionSettings {
  const reviewed = env.ARENA_SANCTIONS_REVIEWED?.trim() || null;
  if (reviewed !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(reviewed) || Number.isNaN(Date.parse(`${reviewed}T00:00:00Z`))))
    throw new Error("ARENA_SANCTIONS_REVIEWED: expected YYYY-MM-DD");
  return {
    countries: codes("ARENA_SANCTIONED", env.ARENA_SANCTIONED, /^[A-Z]{2}$/, SANCTIONED_DEFAULT),
    subdivisions: codes("ARENA_SANCTIONED_REGIONS", env.ARENA_SANCTIONED_REGIONS, /^[A-Z]{2}-[A-Z0-9]{1,3}$/, SANCTIONED_REGIONS_DEFAULT),
    reviewed,
  };
}

/** Days since the last review, or null when no review date is set (also overdue). */
export function reviewOverdue(s: RegionSettings, nowMs: number): { overdue: boolean; days: number | null } {
  if (!s.reviewed) return { overdue: true, days: null };
  const days = Math.floor((nowMs - Date.parse(`${s.reviewed}T00:00:00Z`)) / 86_400_000);
  return { overdue: days > REVIEW_EVERY_DAYS, days };
}
