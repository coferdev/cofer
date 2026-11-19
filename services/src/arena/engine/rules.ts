/**
 * The rules JSON (spec §4.12): RFC 8785 canonical form, keccak256 of it is rulesHash, and parseRules turns it into
 * the engine's Rules. Numbers that matter are decimal strings in the JSON, so no float ever reaches the engine.
 */
import { type Hex, keccak256, toBytes } from "viem";
import { isSymbol, type Symbol } from "../marks/markets";
import { parseWad } from "./detmath";
import { DEFAULT_COLLUSION } from "../scoring/collusion";
import type { Product, Rules } from "./orders";

/** RFC 8785 JCS for the values rules use: objects (keys sorted by UTF-16 code units), arrays, strings, integers, booleans, null. */
export function canonical(v: unknown): string {
  if (v === null || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new Error("rules JSON numbers must be safe integers; use decimal strings");
    return String(v);
  }
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  throw new Error(`not allowed in rules JSON: ${typeof v}`);
}

export const rulesHash = (json: unknown): Hex => keccak256(toBytes(canonical(json)));

const bps = (s: string) => (parseWad(s) * 10_000n) / 10n ** 18n;

export interface RulesJson {
  v: 1;
  mode: "PRACTICE" | "FREEROLL" | "FRIEND" | "HEADSUP";
  markets: string[];
  products: string[];
  leverageCap: { crypto?: number; stock?: number };
  stack: string;
  fillDelayMs: number;
  minHoldSec: number;
  feeBps: number;
  funding: "none";
  lambda: string;
  activity: { minFills: number; minExposure: string };
  options: { premiumBudget: string; spread: string; sigma: Record<string, string>; expiries: string[] };
  marks: { sources: string[]; maxDivergence: string; jumpGuard: string };
  collusion: { O: string; rho: string; sync: number };
  engine: string;
}

export function parseRules(j: RulesJson): Rules & { lambdaBps: bigint; minFills: number; minExposureBps: bigint } {
  if (j.v !== 1) throw new Error(`rules version ${j.v}`);
  if (j.funding !== "none") throw new Error("only funding none is supported");
  if (j.options.spread !== "0.03") throw new Error("the option spread is fixed at 0.03 in this engine build");
  const markets = j.markets.map((m) => {
    if (!isSymbol(m)) throw new Error(`unknown market ${m}`);
    return m;
  });
  const products = j.products.map((p) => {
    if (p !== "SPOT" && p !== "PERP" && p !== "OPTION") throw new Error(`unknown product ${p}`);
    return p as Product;
  });
  const sigma: Partial<Record<Symbol, bigint>> = {};
  for (const [k, v] of Object.entries(j.options.sigma)) {
    if (!isSymbol(k)) throw new Error(`unknown sigma market ${k}`);
    sigma[k] = parseWad(v);
  }
  return {
    markets,
    products,
    leverageCap: {
      ...(j.leverageCap.crypto !== undefined ? { crypto: BigInt(j.leverageCap.crypto) } : {}),
      ...(j.leverageCap.stock !== undefined ? { stock: BigInt(j.leverageCap.stock) } : {}),
    },
    stack: BigInt(j.stack),
    fillDelayMs: j.fillDelayMs,
    minHoldMs: j.minHoldSec * 1000,
    feeBps: BigInt(j.feeBps),
    noMarkMs: 30_000,
    ordersPerSec: 2,
    maxResting: 100,
    optionMarkets: products.includes("OPTION") ? (Object.keys(sigma).filter((s) => markets.includes(s as Symbol)) as Symbol[]) : [],
    sigma,
    premiumBudgetBps: bps(j.options.premiumBudget),
    lambdaBps: bps(j.lambda),
    minFills: j.activity.minFills,
    minExposureBps: bps(j.activity.minExposure),
    collusion: { ...DEFAULT_COLLUSION, oBps: bps(j.collusion.O), rhoBps: bps(j.collusion.rho), sync: j.collusion.sync },
  };
}
