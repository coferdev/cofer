/**
 * Front-end gating for Stock Token buys. The issuer says Stock Tokens may not be offered to US
 * persons, with restrictions in Canada, the UK and Switzerland; the studio also excludes the UAE
 * (research note, unverified). Gating is self-declared region + edge IP country; there is no KYC,
 * so it is NOT enforceable on-chain. A group can vote stock buys only when EVERY member has
 * declared an allowed region (members of a pot share its holdings pro rata).
 */

export const STOCK_EXCLUDED = new Set(["US", "GB", "CA", "CH", "AE"]);

export interface MemberRegion {
  declared?: string | null; // ISO-3166 alpha-2, self-declared at onboarding
  ipCountry?: string | null; // e.g. CF-IPCountry at the edge
}

export function regionAllowsStocks(r: MemberRegion): boolean {
  const d = r.declared?.toUpperCase();
  const ip = r.ipCountry?.toUpperCase();
  if (!d) return false; // must declare
  if (STOCK_EXCLUDED.has(d)) return false;
  if (ip && STOCK_EXCLUDED.has(ip)) return false;
  return true;
}

export interface GroupStockGate {
  allowed: boolean;
  blockedMembers: number;
  undeclaredMembers: number;
}

export function groupCanBuyStocks(members: MemberRegion[]): GroupStockGate {
  let blocked = 0;
  let undeclared = 0;
  for (const m of members) {
    if (!m.declared) undeclared++;
    else if (!regionAllowsStocks(m)) blocked++;
  }
  return { allowed: members.length > 0 && blocked === 0 && undeclared === 0, blockedMembers: blocked, undeclaredMembers: undeclared };
}
