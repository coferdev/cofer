/**
 * The live leaderboard key (spec §5.4): `lb:<table>`, member = seat, read highest first (ZREVRANGE).
 *   score = tier·1e9 + clamp(S·1e6, −1e8, 1e8)
 * Tiers, best first: 2 active survivors, 1 inactive survivors, 0 eliminated. Eliminated seats are ordered by
 * eliminatedAt inside tier 0 (later is higher), as ms since the game started, clamped to the same band.
 * The ZSET is a cache: equal keys may order differently from the final standings' tie-breaks (drawdown, seat
 * index). The log and the final standings are the source of truth.
 */
import type { Standing } from "./score";

export const TIER_STEP = 1_000_000_000;
export const BAND = 100_000_000;

const clamp = (x: number) => Math.max(-BAND, Math.min(BAND, x));

export const lbKey = (table: string) => `lb:${table.toLowerCase()}`;

export function lbScore(s: Pick<Standing, "score1e6" | "activityOk" | "eliminatedAt">, startAt: number): number {
  if (s.eliminatedAt !== null) return clamp(s.eliminatedAt - startAt - BAND);
  const S = s.score1e6 > BigInt(BAND) ? BAND : s.score1e6 < -BigInt(BAND) ? -BAND : Number(s.score1e6);
  return (s.activityOk ? 2 : 1) * TIER_STEP + S;
}

/** The ZADD arguments for one update: [score, member, score, member, ...]. */
export function lbZadd(standings: Standing[], startAt: number): (number | string)[] {
  return standings.flatMap((s) => [lbScore(s, startAt), s.seat.toLowerCase()]);
}
