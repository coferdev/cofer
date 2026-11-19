/**
 * US stock session calendar (spec §4.3): NYSE regular session 09:30–16:00 America/New_York, Mon–Fri, 13:00 on
 * early-close days, closed on NYSE holidays. Pure integer maths on UTC milliseconds (the US daylight-saving rule
 * is written out, not taken from the runtime's time-zone data), so the engine and the replay agree.
 */
import holidays from "./nyse-holidays.json";
import { MARKETS, type Symbol } from "./markets";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MIN = 60_000;

const CLOSED = new Set<string>(holidays.closed);
const EARLY = new Set<string>(holidays.earlyClose);

function ymd(dayMs: number): string {
  return new Date(dayMs).toISOString().slice(0, 10);
}

/** n-th Sunday (1-based) of a month, as the UTC day start in ms. */
function nthSunday(year: number, month0: number, n: number): number {
  const first = Date.UTC(year, month0, 1);
  const dow = new Date(first).getUTCDay();
  return first + (((7 - dow) % 7) + 7 * (n - 1)) * DAY;
}

/** New York offset from UTC in hours (-4 in daylight time, -5 otherwise) at a UTC instant. */
export function nyOffsetHours(utcMs: number): number {
  const y = new Date(utcMs).getUTCFullYear();
  const start = nthSunday(y, 2, 2) + 7 * HOUR; // second Sunday of March, 02:00 EST = 07:00 UTC
  const end = nthSunday(y, 10, 1) + 6 * HOUR; // first Sunday of November, 02:00 EDT = 06:00 UTC
  return utcMs >= start && utcMs < end ? -4 : -5;
}

export interface Session {
  openMs: number;
  closeMs: number;
  early: boolean;
}

/** The session on the New York calendar day that contains utcMs, or null if the market does not open that day. */
export function sessionOnDay(utcMs: number): Session | null {
  const local = utcMs + nyOffsetHours(utcMs) * HOUR;
  const dayStartLocal = Math.floor(local / DAY) * DAY; // local midnight, written as if it were UTC
  const dow = new Date(dayStartLocal).getUTCDay();
  if (dow === 0 || dow === 6) return null;
  const key = ymd(dayStartLocal);
  if (CLOSED.has(key)) return null;
  const early = EARLY.has(key);
  // offset at local noon (about 17:00 UTC); no US clock change happens between 09:30 and 16:00
  const off = nyOffsetHours(dayStartLocal + 17 * HOUR);
  const openMs = dayStartLocal + 9 * HOUR + 30 * MIN - off * HOUR;
  const closeMs = dayStartLocal + (early ? 13 : 16) * HOUR - off * HOUR;
  return { openMs, closeMs, early };
}

export function inSession(utcMs: number): boolean {
  const s = sessionOnDay(utcMs);
  return !!s && utcMs >= s.openMs && utcMs < s.closeMs;
}

/** True when the symbol can trade at this instant: crypto always, stocks only in session. */
export function marketOpen(symbol: Symbol, utcMs: number): boolean {
  return MARKETS[symbol].cls === "crypto" || inSession(utcMs);
}

/** Start of the next session strictly after utcMs (searches up to 14 days ahead). */
export function nextSessionOpen(utcMs: number): number | null {
  for (let d = 0; d <= 14; d++) {
    const s = sessionOnDay(utcMs + d * DAY);
    if (s && s.openMs > utcMs) return s.openMs;
  }
  return null;
}

/** Session minutes inside [startMs, endMs): the engine refuses a stock game with none (spec §4.3). */
export function sessionMinutes(startMs: number, endMs: number): number {
  let total = 0;
  for (let t = Math.floor(startMs / DAY) * DAY - DAY; t < endMs + DAY; t += DAY) {
    const s = sessionOnDay(t + 12 * HOUR);
    if (!s) continue;
    const a = Math.max(s.openMs, startMs);
    const b = Math.min(s.closeMs, endMs);
    if (b > a) total += b - a;
  }
  return Math.floor(total / MIN);
}
