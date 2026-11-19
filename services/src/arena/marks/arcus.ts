/**
 * Arcus source (spec §4.2): public GET https://api.arcus.xyz/v1/markets once a second. Uses the oracle price and
 * isOutsideRth (stocks outside regular hours do not count in v2.0). Terms of use for this data: open decision 9.
 */
import { isSymbol, parsePrice } from "./markets";
import { FLAG_NOT_ONLINE, FLAG_OUTSIDE_RTH, type Quote } from "./median";
import type { SourceHandle } from "./lighter";

export const ARCUS_REST = "https://api.arcus.xyz/v1/markets";

export function parseArcusMarkets(json: unknown, recvMs: number): Quote[] {
  const list = (json as { markets?: unknown[] })?.markets;
  if (!Array.isArray(list)) return [];
  const out: Quote[] = [];
  for (const m of list as Record<string, unknown>[]) {
    const sym = String(m.baseAsset ?? "");
    if (!isSymbol(sym) || m.quoteAsset !== "USD") continue;
    const px = parsePrice(m.oraclePrice);
    if (px === null) continue;
    let flags = 0;
    if (m.isOutsideRth === true) flags |= FLAG_OUTSIDE_RTH;
    if (m.status !== "ONLINE") flags |= FLAG_NOT_ONLINE;
    out.push({ source: "arcus", symbol: sym, px, recvMs, srcTs: 0, flags });
  }
  return out;
}

export function startArcus(onQuote: (q: Quote) => void, log: (m: string) => void = () => {}): SourceHandle {
  let busy = false;
  const t = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const r = await fetch(ARCUS_REST, { signal: AbortSignal.timeout(2_500), headers: { accept: "application/json" } });
      const recv = Date.now();
      for (const q of parseArcusMarkets(await r.json(), recv)) onQuote(q);
    } catch (err) {
      log(`arcus failed: ${String(err).slice(0, 120)}`);
    } finally {
      busy = false;
    }
  }, 1_000);
  return { stop: () => clearInterval(t) };
}
