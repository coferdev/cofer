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

/* ---------------- The Arena (v2): who may play and who may win a prize ----------------
 * Same signals as above (declared region, edge IP country) plus the network class of the IP. Leave, refund, claim,
 * void, unstake and every group-account action are never gated by this. */

/** Comprehensive-sanctions regions (ISO alpha-2). The live list comes from config and is reviewed monthly. */
export const SANCTIONED_DEFAULT: ReadonlySet<string> = new Set(["CU", "IR", "KP", "SY"]);
/** Friend Tables (paid entry) are off here, as well as on hosting or VPN networks. */
export const FRIEND_BLOCKED: ReadonlySet<string> = new Set(["US", "GB", "CA", "AE", "CH", "SG"]);
export const STOCK_PRIZE_BLOCKED: ReadonlySet<string> = new Set([...STOCK_EXCLUDED, "SG"]);

export type ArenaMode = "PRACTICE" | "FREEROLL" | "FRIEND";
export type AsnClass = "residential" | "mobile" | "hosting" | "vpn" | null;
export type ArenaGate = { play: boolean; prize: boolean; reason?: "region" | "declare-region" | "network" | "mismatch" };

export function arenaGate(
  mode: ArenaMode,
  hasStocks: boolean,
  r: MemberRegion & { asnClass?: AsnClass },
  sanctioned: ReadonlySet<string> = SANCTIONED_DEFAULT,
): ArenaGate {
  const d = r.declared?.toUpperCase() || undefined;
  const ip = r.ipCountry?.toUpperCase() || undefined;
  if ((d && sanctioned.has(d)) || (ip && sanctioned.has(ip))) return { play: false, prize: false, reason: "region" };
  if (mode === "PRACTICE") return { play: true, prize: false };
  if (!d) return mode === "FREEROLL" ? { play: true, prize: false, reason: "declare-region" } : { play: false, prize: false, reason: "declare-region" };
  const hosting = r.asnClass === "hosting" || r.asnClass === "vpn";
  if (mode === "FRIEND") {
    if (hosting) return { play: false, prize: false, reason: "network" };
    if (FRIEND_BLOCKED.has(d) || (ip !== undefined && FRIEND_BLOCKED.has(ip))) return { play: false, prize: false, reason: "region" };
    if (ip !== undefined && ip !== d) return { play: false, prize: false, reason: "mismatch" }; // a paid table: both known and different
    return { play: true, prize: true };
  }
  const prizeBlocked = hosting || (hasStocks && (STOCK_PRIZE_BLOCKED.has(d) || (!!ip && STOCK_PRIZE_BLOCKED.has(ip))));
  return prizeBlocked ? { play: true, prize: false, reason: hosting ? "network" : "region" } : { play: true, prize: true };
}
