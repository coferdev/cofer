/**
 * Arena markets (spec §4.2, §4.3). Prices are bigint at 1e8. The price tick is the Lighter RH market's own price
 * step (supported_price_decimals, read 2026-11-19), which matches Arcus' tick for the same markets.
 */
export type Symbol = "BTC" | "ETH" | "NVDA" | "TSLA" | "SPY";
export type MarketClass = "crypto" | "stock";

export const PRICE_SCALE = 10n ** 8n;

export interface Market {
  symbol: Symbol;
  cls: MarketClass;
  /** Price tick at 1e8: BTC 0.1, others 0.01. */
  tick: bigint;
}

export const MARKETS: Record<Symbol, Market> = {
  BTC: { symbol: "BTC", cls: "crypto", tick: 10_000_000n },
  ETH: { symbol: "ETH", cls: "crypto", tick: 1_000_000n },
  NVDA: { symbol: "NVDA", cls: "stock", tick: 1_000_000n },
  TSLA: { symbol: "TSLA", cls: "stock", tick: 1_000_000n },
  SPY: { symbol: "SPY", cls: "stock", tick: 1_000_000n },
};

export const SYMBOLS = Object.keys(MARKETS) as Symbol[];

export function isSymbol(s: string): s is Symbol {
  return Object.prototype.hasOwnProperty.call(MARKETS, s);
}

/**
 * Decimal text (or a JSON number) -> bigint at 1e8, rounded down. Refuses exponents, signs and junk, so a bad
 * venue reply can never become a price.
 */
export function parsePrice(v: unknown): bigint | null {
  const s = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : typeof v === "string" ? v.trim() : "";
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [i, f = ""] = s.split(".");
  const px = BigInt(i!) * PRICE_SCALE + BigInt((f + "00000000").slice(0, 8));
  return px > 0n ? px : null;
}
