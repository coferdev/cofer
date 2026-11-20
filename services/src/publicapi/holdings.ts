/**
 * GET /v1/pots/:pot/holdings?from=YYYY-MM-DD&to=YYYY-MM-DD: a group account's raw balance of each token, day by day,
 * from the daily snapshots (docs/ledgers.md). Balances only: no price, value or total, in any field. At most
 * HOLDINGS_MAX_DAYS days per request; without dates, the last 30 days.
 */
import { getAddress, type Address } from "viem";

export const HOLDINGS_CACHE_MS = 300_000;
export const HOLDINGS_MAX_DAYS = 366;

export interface HoldingsDeps {
  rows(pot: Address, from: string, to: string): Promise<{ asset: string; day: string; block: bigint; blockTime: number; rawBalance: string }[]>;
  token(a: Address): Promise<{ symbol: string; decimals: number } | null>;
  now(): number; // unix seconds
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const valid = (d: string) => DAY.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d);
const shift = (d: string, days: number) => new Date(Date.parse(`${d}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** The checked date range, or a plain reason. */
export function rangeParams(from: string | undefined, to: string | undefined, now: number): { from: string; to: string } | { why: string } {
  const today = new Date(now * 1000).toISOString().slice(0, 10);
  const t = to || today;
  const f = from || shift(t, -29);
  if (!valid(f) || !valid(t)) return { why: "from and to are dates like 2026-12-01." };
  if (f > t) return { why: "from must not be after to." };
  if ((Date.parse(t) - Date.parse(f)) / 86_400_000 + 1 > HOLDINGS_MAX_DAYS) return { why: `At most ${HOLDINGS_MAX_DAYS} days per request.` };
  return { from: f, to: t };
}

export async function readHoldings(d: HoldingsDeps, pot: Address, from: string, to: string) {
  const rows = await d.rows(pot, from, to);
  const tokens = new Map<string, { symbol: string; decimals: number } | null>();
  for (const r of rows) if (!tokens.has(r.asset.toLowerCase())) tokens.set(r.asset.toLowerCase(), await d.token(getAddress(r.asset)));
  const days = new Map<string, { day: string; block: bigint; blockTime: number; balances: { asset: Address; symbol: string | null; decimals: number | null; rawBalance: string }[] }>();
  for (const r of [...rows].sort((a, b) => a.day.localeCompare(b.day) || a.asset.localeCompare(b.asset))) {
    const day = days.get(r.day) ?? { day: r.day, block: r.block, blockTime: r.blockTime, balances: [] };
    const t = tokens.get(r.asset.toLowerCase());
    day.balances.push({ asset: getAddress(r.asset), symbol: t?.symbol ?? null, decimals: t?.decimals ?? null, rawBalance: r.rawBalance });
    days.set(r.day, day);
  }
  return { pot, from, to, days: [...days.values()] };
}
