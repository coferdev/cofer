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

const SLIP_RE = /^slip=/i;

/** Optional "slip=0.5" / "slip=0.5%" (shared by /buy and /sell): default 1%, allowed 0.01%..10%. */
function parseSlip(words: string[]): number {
  let slipBps = 100;
  for (const w of words) {
    if (!SLIP_RE.test(w)) continue;
    const m = /^slip=(\d+(\.\d+)?)%?$/i.exec(w);
    if (!m) throw new UserError("slip must look like slip=0.5 (percent)");
    slipBps = Math.round(Number(m[1]) * 100);
  }
  if (slipBps < 1 || slipBps > 1000) throw new UserError("slip must be between 0.01% and 10%");
  return slipBps;
}

/** "/buy TSLA 100" or "/buy TSLA 100 slip=0.5" */
export function parseBuy(text: string): BuyCmd {
  const [, symbol, amount, ...rest] = text.trim().split(/\s+/);
  if (!symbol || !/^[A-Za-z.]{1,10}$/.test(symbol)) throw new UserError("usage: /buy SYMBOL AMOUNT_USDG");
  const slipBps = parseSlip(rest);
  return { symbol: symbol.toUpperCase(), usdg: parseUsdg(amount), slipBps };
}

export interface SellCmd {
  symbol: string;
  pctBps: number;
  slipBps: number;
}

/** "/sell TSLA 50%", "/sell TSLA all" or "/sell TSLA 50% slip=0.5" (no amount = all) */
export function parseSell(text: string): SellCmd {
  const [, symbol, ...rest] = text.trim().split(/\s+/);
  if (!symbol || SLIP_RE.test(symbol)) throw new UserError("usage: /sell SYMBOL PERCENT|all [slip=0.5]");
  const slipBps = parseSlip(rest);
  const amt = rest.find((w) => !SLIP_RE.test(w));
  if (!amt || /^all$/i.test(amt)) return { symbol: symbol.toUpperCase(), pctBps: 10_000, slipBps };
  const m = /^(\d+(\.\d+)?)%$/.exec(amt);
  if (!m) throw new UserError("usage: /sell SYMBOL 25%");
  const pctBps = Math.round(Number(m[1]) * 100);
  if (pctBps < 1 || pctBps > 10_000) throw new UserError("percent 0.01..100");
  return { symbol: symbol.toUpperCase(), pctBps, slipBps };
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
