/**
 * Vote bookkeeping that mirrors CoferPot._countVotes / requiredVotes / guard-delay rules.
 * Votes are EIP-712 signatures from members' own keys (passkey smart accounts via ERC-1271, or
 * EOAs). A Telegram button tap is never a vote: it only opens the signer page.
 */
import { getAddress, type Address, type Hex } from "viem";
import { Kind } from "./proposal";

export interface Vote {
  signer: Address;
  signature: Hex;
}

export interface PotRules {
  members: Address[];
  threshold: number; // used when thresholdBps == 0
  thresholdBps: number;
  guardDelay: number; // seconds
}

export function requiredVotes(r: Pick<PotRules, "members" | "threshold" | "thresholdBps">): number {
  const n = r.members.length;
  if (n === 0) return Number.POSITIVE_INFINITY;
  if (r.thresholdBps > 0) {
    const req = Math.ceil((n * r.thresholdBps) / 10_000);
    return Math.max(1, req);
  }
  return Math.min(r.threshold, n);
}

/** Sort ascending by address (numeric), dedupe; the contract rejects unsorted or duplicate signers. */
export function sortVotes(votes: Vote[]): Vote[] {
  const seen = new Set<string>();
  const out: Vote[] = [];
  for (const v of votes) {
    const k = v.signer.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ signer: getAddress(v.signer), signature: v.signature });
  }
  return out.sort((a, b) => (BigInt(a.signer) < BigInt(b.signer) ? -1 : 1));
}

export interface Tally {
  approvals: number;
  required: number;
  ready: boolean;
  unanimous: boolean;
  delaySeconds: number;
  counted: Address[];
  ignored: { signer: Address; reason: "not_member" | "revoked" }[];
}

/**
 * Counts only current, non-revoked members. Signatures must already be verified
 * (services/proposals verifies each with viem verifyTypedData, which supports ERC-1271).
 */
export function tally(rules: PotRules, kind: Kind, votes: Vote[], revoked: Set<string> = new Set()): Tally {
  const memberSet = new Set(rules.members.map((m) => m.toLowerCase()));
  const counted: Address[] = [];
  const ignored: Tally["ignored"] = [];
  for (const v of sortVotes(votes)) {
    const k = v.signer.toLowerCase();
    if (!memberSet.has(k)) ignored.push({ signer: v.signer, reason: "not_member" });
    else if (revoked.has(k)) ignored.push({ signer: v.signer, reason: "revoked" });
    else counted.push(v.signer);
  }
  const required = requiredVotes(rules);
  const approvals = counted.length;
  const unanimous = approvals >= rules.members.length;
  const delaySeconds = kind === Kind.SWAP || unanimous ? 0 : rules.guardDelay;
  return { approvals, required, ready: approvals >= required, unanimous, delaySeconds, counted, ignored };
}

/** Votes to submit on-chain: only counted signers, sorted (smallest valid calldata). */
export function packVotes(votes: Vote[], counted: Address[]): Vote[] {
  const ok = new Set(counted.map((c) => c.toLowerCase()));
  return sortVotes(votes.filter((v) => ok.has(v.signer.toLowerCase())));
}
