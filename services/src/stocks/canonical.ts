/**
 * Canonical Stock Token list from the issuer's public API (GET {base}/assets).
 * Anyone can deploy a token called "TSLA"; only addresses returned here for chainId 4663 are ever
 * listed on the factory or shown as stocks. Fail closed: unknown address => not a stock.
 */
import { getAddress, type Address } from "viem";

export interface CanonicalStock {
  symbol: string;
  address: Address;
  decimals: number;
  currentMultiplier: string; // 18-dp decimal string
  pendingMultiplier?: string | null;
  pendingEffectiveAt?: string | null;
  status?: string | null;
  tradable: boolean;
}

type RawAsset = {
  tokenSymbol?: string; // current field name (seen 2026-10-30)
  symbol?: string;
  ticker?: string;
  status?: string;
  tokenDecimals?: number;
  currentMultiplier?: string;
  pendingMultiplier?: string | null;
  pendingMultiplierEffectiveTime?: string | null;
  tradingCapabilities?: unknown;
  deployments?: { contractAddress?: string; chainId?: number | string }[];
};

/** Tolerant parser: the API returns an array or an object wrapping one (field names per docs). */
export function parseAssets(json: unknown, chainId = 4663): CanonicalStock[] {
  const list: RawAsset[] = Array.isArray(json)
    ? (json as RawAsset[])
    : (((json as Record<string, unknown>)?.results ??
        (json as Record<string, unknown>)?.assets ??
        (json as Record<string, unknown>)?.data ??
        []) as RawAsset[]);
  const out: CanonicalStock[] = [];
  for (const a of list) {
    const symbol = a.tokenSymbol ?? a.symbol ?? a.ticker;
    const dep = a.deployments?.find((d) => Number(d.chainId) === chainId && d.contractAddress);
    if (!symbol || !dep?.contractAddress) continue;
    let address: Address;
    try {
      address = getAddress(dep.contractAddress);
    } catch {
      continue;
    }
    const status = a.status ?? null;
    out.push({
      symbol,
      address,
      decimals: a.tokenDecimals ?? 18,
      currentMultiplier: a.currentMultiplier ?? "1",
      pendingMultiplier: a.pendingMultiplier || null, // the API sends "" when nothing is pending
      pendingEffectiveAt: a.pendingMultiplierEffectiveTime || null,
      status,
      // whole-word match, so INACTIVE / UNTRADABLE / DISABLED never count; no status => not tradable
      tradable: !!status && /^(ASSET_STATUS_)?(ACTIVE|TRADABLE|ENABLED)$/i.test(status),
    });
  }
  return out;
}

export async function fetchCanonicalStocks(base: string, chainId = 4663): Promise<CanonicalStock[]> {
  const res = await fetch(`${base}/assets`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`stock api ${res.status}`);
  return parseAssets(await res.json(), chainId);
}

export function isCanonical(list: CanonicalStock[], addr: string): boolean {
  const a = addr.toLowerCase();
  return list.some((s) => s.address.toLowerCase() === a);
}

/** "1.0" style 18-dp decimal string -> 1e18-scaled bigint. */
export function multiplierToWad(s: string): bigint {
  const [i, f = ""] = s.split(".");
  return BigInt(i || "0") * 10n ** 18n + BigInt((f + "0".repeat(18)).slice(0, 18) || "0");
}
