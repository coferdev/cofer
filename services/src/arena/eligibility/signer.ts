/**
 * The eligibility signer (spec §3.4, §4.11, §11). TableEscrow.join* needs an
 * Eligibility(table, player, mode, prizeEligible, expiry) signature from the factory's eligibility signer, so this is
 * the one place the region gate binds. It gates entry only: leave, refund, claim and void never need it.
 *
 * Before signing: the region gate (geo.ts arenaGate), one seat per Telegram account, smart account and passkey
 * credential, membership of the Telegram chat for a group table, and for a Freeroll prize an account at least 72 h
 * old with one finished Practice game and no open cluster flag. A Friend Table seat must be prize-eligible (the
 * escrow refuses otherwise), so anything that blocks the prize there refuses the seat.
 * Every decision is returned with its reason for the geo_checks audit row; raw IPs are never part of it.
 */
import { type Hex, encodeAbiParameters, hashTypedData } from "viem";
import { type ArenaGate, type AsnClass, arenaGate } from "../../core/geo";
import { type RegionSettings, defaultRegionSettings } from "./regions";

/** The escrow accepts expiry ≤ block.timestamp + 10 min; a minute of margin for clock drift. */
export const ELIGIBILITY_TTL_S = 9 * 60;
export const MIN_ACCOUNT_AGE_MS = 72 * 3_600_000;

export const MODE_CODE = { FRIEND: 0, FREEROLL: 1 } as const;
export type TableMode = keyof typeof MODE_CODE;

export interface EligibilityAsk {
  chainId: number;
  table: Hex;
  mode: TableMode;
  hasStocks: boolean;
  player: Hex; // the smart account that will hold the seat
  telegramId: string;
  credentialId: string; // passkey credential ID
  declared?: string | null;
  ipCountry?: string | null;
  /** ISO 3166-2 subdivision from the edge (geo.ts subdivisionOf), when the edge sends one. */
  ipRegion?: string | null;
  asnClass?: AsnClass;
  accountCreatedAt: number; // ms
  practiceGamesFinished: number;
  /** Seats this table already has (from the indexer), and who holds them. */
  seated: { player: string; telegramId: string; credentialId: string }[];
  /** A table tied to a Telegram group: whether getChatMember says this user is a member. Undefined for other tables. */
  chatMember?: boolean;
  /** An open off-chain cluster flag (shared funding, same network + device + agent within 24 h, ...). */
  clusterFlag?: boolean;
  now: number; // ms
}

export type Refusal = "region" | "declare-region" | "network" | "mismatch" | "seated" | "telegram-seated" | "credential-seated" | "not-in-chat";
export type Decision =
  | { ok: true; prizeEligible: boolean; prizeReason?: string; gate: ArenaGate }
  | { ok: false; refusal: Refusal; gate: ArenaGate };

export function decide(q: EligibilityAsk, regions: RegionSettings = defaultRegionSettings): Decision {
  const gate = arenaGate(q.mode, q.hasStocks, { declared: q.declared, ipCountry: q.ipCountry, ipRegion: q.ipRegion, asnClass: q.asnClass }, regions.countries, regions.subdivisions);
  if (!gate.play) return { ok: false, refusal: gate.reason ?? "region", gate };
  const lc = (s: string) => s.toLowerCase();
  if (q.seated.some((s) => lc(s.player) === lc(q.player))) return { ok: false, refusal: "seated", gate };
  if (q.seated.some((s) => s.telegramId === q.telegramId)) return { ok: false, refusal: "telegram-seated", gate };
  if (q.seated.some((s) => s.credentialId === q.credentialId)) return { ok: false, refusal: "credential-seated", gate };
  if (q.chatMember === false) return { ok: false, refusal: "not-in-chat", gate };
  if (q.mode === "FRIEND") return { ok: true, prizeEligible: true, gate };
  let prizeReason: string | undefined = gate.prize ? undefined : (gate.reason ?? "region");
  if (!prizeReason && q.now - q.accountCreatedAt < MIN_ACCOUNT_AGE_MS) prizeReason = "account-age";
  if (!prizeReason && q.practiceGamesFinished < 1) prizeReason = "no-practice";
  if (!prizeReason && q.clusterFlag) prizeReason = "cluster";
  return { ok: true, prizeEligible: !prizeReason, prizeReason, gate };
}

export function eligibilityDigest(chainId: number, table: Hex, player: Hex, mode: TableMode, prizeEligible: boolean, expiry: bigint): Hex {
  return hashTypedData({
    domain: { name: "Cofer Arena", version: "1", chainId, verifyingContract: table },
    types: {
      Eligibility: [
        { name: "table", type: "address" },
        { name: "player", type: "address" },
        { name: "mode", type: "uint8" },
        { name: "prizeEligible", type: "bool" },
        { name: "expiry", type: "uint64" },
      ],
    },
    primaryType: "Eligibility",
    message: { table, player, mode: MODE_CODE[mode], prizeEligible, expiry },
  });
}

/** The `eligibility` bytes join* takes: abi.encode(bool prizeEligible, uint64 expiry, bytes sig). */
export const encodeEligibility = (prizeEligible: boolean, expiry: bigint, sig: Hex): Hex =>
  encodeAbiParameters([{ type: "bool" }, { type: "uint64" }, { type: "bytes" }], [prizeEligible, expiry, sig]);

/** Signs a 32-byte digest with the eligibility key (a KMS key in production; never a key in this process's env). */
export type DigestSigner = (digest: Hex) => Promise<Hex>;

export type Issued =
  | { ok: true; prizeEligible: boolean; prizeReason?: string; expiry: number; eligibility: Hex; decision: Decision }
  | { ok: false; refusal: Refusal; decision: Decision };

export async function issue(q: EligibilityAsk, sign: DigestSigner, regions?: RegionSettings): Promise<Issued> {
  const d = decide(q, regions);
  if (!d.ok) return { ok: false, refusal: d.refusal, decision: d };
  const expiry = BigInt(Math.floor(q.now / 1000) + ELIGIBILITY_TTL_S);
  const sig = await sign(eligibilityDigest(q.chainId, q.table, q.player, q.mode, d.prizeEligible, expiry));
  return { ok: true, prizeEligible: d.prizeEligible, prizeReason: d.prizeReason, expiry: Number(expiry), eligibility: encodeEligibility(d.prizeEligible, expiry, sig), decision: d };
}
