/** Pure command parsing (unit-tested). Amounts are USDG with 6 decimals. Errors are UserErrors (shown in chat). */
import { parseUnits } from "viem";
import { UserError } from "../core/errors";

export function parseUsdg(s: string | undefined): bigint {
  if (!s) throw new UserError("amount missing");
  const clean = s.replace(/[$,_]/g, "").replace(/usdg$/i, "");
  if (!/^\d+(\.\d{1,6})?$/.test(clean)) throw new UserError(`bad amount "${s}"`);
  const v = parseUnits(clean, 6);
  if (v <= 0n) throw new UserError("amount must be > 0");
  return v;
}

const UNITS: Record<string, number> = { h: 3600, hour: 3600, d: 86400, day: 86400, w: 604800, week: 604800, m: 2592000, month: 2592000 };

export function parsePeriod(s: string | undefined): number {
  if (!s) return 604800;
  const m = /^(\d+)?\s*(h|hour|d|day|w|week|m|month)s?$/i.exec(s.trim());
  if (!m) throw new UserError(`bad period "${s}" (try day, week, 3d, month)`);
  return Number(m[1] ?? 1) * UNITS[m[2]!.toLowerCase()]!;
}

export interface BuyCmd {
  symbol: string;
  usdg: bigint;
  slipBps: number;
}

/** "/buy TSLA 100" or "/buy TSLA 100 slip=0.5" */
export function parseBuy(text: string): BuyCmd {
  const [, symbol, amount, ...rest] = text.trim().split(/\s+/);
  if (!symbol || !/^[A-Za-z.]{1,10}$/.test(symbol)) throw new UserError("usage: /buy SYMBOL AMOUNT_USDG");
  let slipBps = 100;
  for (const r of rest) {
    const m = /^slip=(\d+(\.\d+)?)%?$/i.exec(r);
    if (m) slipBps = Math.round(Number(m[1]) * 100);
  }
  if (slipBps < 1 || slipBps > 1000) throw new UserError("slip must be between 0.01% and 10%");
  return { symbol: symbol.toUpperCase(), usdg: parseUsdg(amount), slipBps };
}

/** "/sell TSLA 50%" or "/sell TSLA all" */
export function parseSell(text: string): { symbol: string; pctBps: number } {
  const [, symbol, amt] = text.trim().split(/\s+/);
  if (!symbol) throw new UserError("usage: /sell SYMBOL PERCENT|all");
  if (!amt || /^all$/i.test(amt)) return { symbol: symbol.toUpperCase(), pctBps: 10_000 };
  const m = /^(\d+(\.\d+)?)%$/.exec(amt);
  if (!m) throw new UserError("usage: /sell SYMBOL 25%");
  const pctBps = Math.round(Number(m[1]) * 100);
  if (pctBps < 1 || pctBps > 10_000) throw new UserError("percent 0.01..100");
  return { symbol: symbol.toUpperCase(), pctBps };
}

/** "/allowance @alice 50 week" */
export function parseAllowance(text: string): { who: string; usdg: bigint; period: number } {
  const [, who, amount, period] = text.trim().split(/\s+/);
  if (!who) throw new UserError("usage: /allowance @member AMOUNT [day|week|month]");
  const usdg = amount === "0" || amount === "off" ? 0n : parseUsdg(amount);
  return { who, usdg, period: usdg === 0n ? 0 : parsePeriod(period) };
}

/** "/send 120 @bob" or "/send 120 0xabc..." */
export function parseSend(text: string): { usdg: bigint; to: string } {
  const [, amount, to] = text.trim().split(/\s+/);
  if (!to) throw new UserError("usage: /send AMOUNT @member|0xaddress");
  return { usdg: parseUsdg(amount), to };
}
