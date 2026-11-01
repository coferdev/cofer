/**
 * Proposal encoding + EIP-712 typed data. Must stay byte-identical to CoferPot.sol:
 *   Proposal(uint8 kind,bytes data,uint256 nonce,uint64 epoch,uint64 deadline)
 *   domain = { name: "Cofer", version: "1", chainId, verifyingContract: pot }
 * Parity is tested in test/proposal.test.ts (manual Solidity-style encoding + compiled bytecode).
 */
import {
  decodeAbiParameters,
  encodeAbiParameters,
  formatUnits,
  hashTypedData,
  type Address,
  type Hex,
} from "viem";

export enum Kind {
  TRANSFER = 0,
  SWAP = 1,
  ADD_MEMBER = 2,
  REMOVE_MEMBER = 3,
  SET_ALLOWANCE = 4,
  SET_THRESHOLD = 5,
  SET_CONFIG = 6,
  PAY_PLAN = 7,
}

export const PROPOSAL_TYPES = {
  Proposal: [
    { name: "kind", type: "uint8" },
    { name: "data", type: "bytes" },
    { name: "nonce", type: "uint256" },
    { name: "epoch", type: "uint64" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

export const DOMAIN_NAME = "Cofer";
export const DOMAIN_VERSION = "1";

export type Action =
  | { kind: Kind.TRANSFER; asset: Address; to: Address; amount: bigint }
  | {
      kind: Kind.SWAP;
      adapter: Address;
      tokenIn: Address;
      tokenOut: Address;
      amountIn: bigint;
      minOut: bigint;
      route: Hex;
    }
  | { kind: Kind.ADD_MEMBER; member: Address }
  | { kind: Kind.REMOVE_MEMBER; member: Address }
  | { kind: Kind.SET_ALLOWANCE; member: Address; amount: bigint; period: number }
  | { kind: Kind.SET_THRESHOLD; threshold: number; thresholdBps: number }
  | {
      kind: Kind.SET_CONFIG;
      guardDelay: number;
      maxSlipBps: number;
      entrySpreadBps: number;
      depositsOpen: boolean;
    }
  | { kind: Kind.PAY_PLAN; months: number; maxCost: bigint }; // maxCost in USDG base units: the pot refuses to pay more

export interface ProposalEnvelope {
  pot: Address;
  chainId: number;
  kind: Kind;
  data: Hex;
  nonce: bigint;
  epoch: bigint;
  deadline: bigint;
}

const P = {
  transfer: [{ type: "address" }, { type: "address" }, { type: "uint256" }],
  swap: [
    { type: "address" },
    { type: "address" },
    { type: "address" },
    { type: "uint256" },
    { type: "uint256" },
    { type: "bytes" },
  ],
  member: [{ type: "address" }],
  allowance: [{ type: "address" }, { type: "uint128" }, { type: "uint32" }],
  threshold: [{ type: "uint8" }, { type: "uint16" }],
  config: [{ type: "uint32" }, { type: "uint16" }, { type: "uint16" }, { type: "bool" }],
  plan: [{ type: "uint8" }, { type: "uint256" }],
} as const;

/** Mirrors the bounds CoferPot enforces, so bad proposals fail before anyone signs. */
export const LIMITS = {
  MAX_GUARD_DELAY: 3 * 24 * 3600,
  MAX_SLIP_BPS: 1000,
  MAX_ENTRY_SPREAD_BPS: 200,
  MIN_ALLOWANCE_PERIOD: 3600,
  MAX_ALLOWANCE_PERIOD: 90 * 24 * 3600,
  MAX_PLAN_MONTHS: 12,
  MAX_TTL_SECONDS: 7 * 24 * 3600, // service policy (contract only checks deadline)
} as const;

export function encodeAction(a: Action): { kind: Kind; data: Hex } {
  switch (a.kind) {
    case Kind.TRANSFER:
      if (a.amount <= 0n) throw new Error("amount must be > 0");
      return { kind: a.kind, data: encodeAbiParameters(P.transfer, [a.asset, a.to, a.amount]) };
    case Kind.SWAP:
      if (a.amountIn <= 0n || a.minOut <= 0n) throw new Error("amountIn and minOut must be > 0");
      return {
        kind: a.kind,
        data: encodeAbiParameters(P.swap, [a.adapter, a.tokenIn, a.tokenOut, a.amountIn, a.minOut, a.route]),
      };
    case Kind.ADD_MEMBER:
    case Kind.REMOVE_MEMBER:
      return { kind: a.kind, data: encodeAbiParameters(P.member, [a.member]) };
    case Kind.SET_ALLOWANCE:
      if (a.amount > 0n && (a.period < LIMITS.MIN_ALLOWANCE_PERIOD || a.period > LIMITS.MAX_ALLOWANCE_PERIOD)) {
        throw new Error("allowance period out of range");
      }
      return { kind: a.kind, data: encodeAbiParameters(P.allowance, [a.member, a.amount, a.period]) };
    case Kind.SET_THRESHOLD:
      if (a.thresholdBps > 10_000 || (a.thresholdBps === 0 && a.threshold < 1)) throw new Error("bad threshold");
      return { kind: a.kind, data: encodeAbiParameters(P.threshold, [a.threshold, a.thresholdBps]) };
    case Kind.SET_CONFIG:
      if (
        a.guardDelay > LIMITS.MAX_GUARD_DELAY ||
        a.maxSlipBps > LIMITS.MAX_SLIP_BPS ||
        a.entrySpreadBps > LIMITS.MAX_ENTRY_SPREAD_BPS
      ) {
        throw new Error("config out of range");
      }
      return {
        kind: a.kind,
        data: encodeAbiParameters(P.config, [a.guardDelay, a.maxSlipBps, a.entrySpreadBps, a.depositsOpen]),
      };
    case Kind.PAY_PLAN:
      if (a.months < 1 || a.months > LIMITS.MAX_PLAN_MONTHS) throw new Error("months 1..12");
      if (a.maxCost < 0n) throw new Error("maxCost must not be negative");
      return { kind: a.kind, data: encodeAbiParameters(P.plan, [a.months, a.maxCost]) };
  }
}

export function decodeAction(kind: Kind, data: Hex): Action {
  switch (kind) {
    case Kind.TRANSFER: {
      const [asset, to, amount] = decodeAbiParameters(P.transfer, data);
      return { kind, asset, to, amount };
    }
    case Kind.SWAP: {
      const [adapter, tokenIn, tokenOut, amountIn, minOut, route] = decodeAbiParameters(P.swap, data);
      return { kind, adapter, tokenIn, tokenOut, amountIn, minOut, route };
    }
    case Kind.ADD_MEMBER:
    case Kind.REMOVE_MEMBER: {
      const [member] = decodeAbiParameters(P.member, data);
      return { kind, member };
    }
    case Kind.SET_ALLOWANCE: {
      const [member, amount, period] = decodeAbiParameters(P.allowance, data);
      return { kind, member, amount, period };
    }
    case Kind.SET_THRESHOLD: {
      const [threshold, thresholdBps] = decodeAbiParameters(P.threshold, data);
      return { kind, threshold, thresholdBps };
    }
    case Kind.SET_CONFIG: {
      const [guardDelay, maxSlipBps, entrySpreadBps, depositsOpen] = decodeAbiParameters(P.config, data);
      return { kind, guardDelay, maxSlipBps, entrySpreadBps, depositsOpen };
    }
    case Kind.PAY_PLAN: {
      const [months, maxCost] = decodeAbiParameters(P.plan, data);
      return { kind, months, maxCost };
    }
    default:
      throw new Error(`unknown kind ${kind}`);
  }
}

export function typedData(p: ProposalEnvelope) {
  return {
    domain: { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId: p.chainId, verifyingContract: p.pot },
    types: PROPOSAL_TYPES,
    primaryType: "Proposal" as const,
    message: { kind: p.kind, data: p.data, nonce: p.nonce, epoch: p.epoch, deadline: p.deadline },
  };
}

/** The digest members sign and CoferPot.hashProposal() returns. */
export function proposalDigest(p: ProposalEnvelope): Hex {
  return hashTypedData(typedData(p));
}

/** 256-bit random nonce: proposals never block each other (no sequential nonce). */
export function randomNonce(): bigint {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return BigInt("0x" + Buffer.from(b).toString("hex"));
}

export interface TokenMeta {
  symbol: string;
  decimals: number;
}

/**
 * Human-readable rendering shown on the signer page and in the chat card. Rendered from the
 * decoded calldata itself (never from free text), so what people read is what they sign.
 */
export function describe(a: Action, tokens: (addr: Address) => TokenMeta, name: (addr: Address) => string): string {
  const amt = (v: bigint, t: Address) => `${formatUnits(v, tokens(t).decimals)} ${tokens(t).symbol}`;
  switch (a.kind) {
    case Kind.TRANSFER:
      return `Send ${amt(a.amount, a.asset)} to ${name(a.to)}`;
    case Kind.SWAP:
      return `Swap ${amt(a.amountIn, a.tokenIn)} for at least ${amt(a.minOut, a.tokenOut)}`;
    case Kind.ADD_MEMBER:
      return `Add ${name(a.member)} as a member`;
    case Kind.REMOVE_MEMBER:
      return `Remove ${name(a.member)} (they receive their exact share first)`;
    case Kind.SET_ALLOWANCE:
      return a.amount === 0n
        ? `Turn off ${name(a.member)}'s allowance`
        : `Give ${name(a.member)} an allowance of ${formatUnits(a.amount, 6)} USDG every ${humanPeriod(a.period)}`;
    case Kind.SET_THRESHOLD:
      return a.thresholdBps > 0
        ? `Require ${a.thresholdBps / 100}% of members to approve votes`
        : `Require ${a.threshold} approvals for votes`;
    case Kind.SET_CONFIG:
      return `Settings: exit window ${humanPeriod(a.guardDelay)}, max slippage ${a.maxSlipBps / 100}%, entry spread ${a.entrySpreadBps / 100}%, deposits ${a.depositsOpen ? "open" : "closed"}`;
    case Kind.PAY_PLAN:
      return `Prepay the group plan for ${a.months} month${a.months === 1 ? "" : "s"} (at most ${formatUnits(a.maxCost, 6)} USDG)`;
  }
}

export function humanPeriod(s: number): string {
  if (s === 0) return "none";
  if (s % 86400 === 0) {
    const d = s / 86400;
    if (d === 7) return "week";
    return d === 1 ? "day" : `${d} days`;
  }
  if (s % 3600 === 0) return s / 3600 === 1 ? "hour" : `${s / 3600} hours`;
  return `${s}s`;
}
