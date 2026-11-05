/**
 * Does a Chainlink feed name the asset we are about to use it for? Feed addresses are kept by hand in
 * src/chain/addresses.ts, so before a stock is listed (scripts/build-asset-list.ts) or tested on a
 * fork (scripts/fork-swap-test.ts), the feed's own description() must name that asset and be priced
 * in USD. Robinhood Chain feed names look like "RHTSLA / USD", "Robinhood AAPL / USD", "USDG / USD".
 */

/** Why this feed does not fit `symbol`, or null when it does. */
export function feedNameProblem(description: string, symbol: string): string | null {
  const sym = symbol.trim().toUpperCase();
  const parts = description.split("/").map((p) => p.trim().toUpperCase());
  if (parts.length !== 2 || !parts[0] || !sym) return `feed is "${description}", not a "<asset> / USD" feed`;
  const [base, quote] = parts as [string, string];
  if (quote !== "USD") return `feed is "${description}", which is not priced in USD`;
  if (![sym, `RH${sym}`, `ROBINHOOD ${sym}`].includes(base)) return `feed is "${description}", not ${sym}`;
  return null;
}
