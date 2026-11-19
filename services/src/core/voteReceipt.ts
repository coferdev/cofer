/**
 * A vote's receipt: the exact EIP-712 message every approver signed (domain, types and message), the digest made
 * again from it, who approved, whether each approval still verifies (ERC-1271 for keys that are accounts), and how to
 * recompute the digest yourself. Read from the vote's own bytes and the chain; never the bot's stored summary or any
 * Telegram column.
 */
import { getAddress, type Address, type Hex } from "viem";
import { Kind, proposalDigest, typedData, type ProposalEnvelope } from "./proposal";
import { KIND_NAMES } from "./txExplain";
import { castCall, type CheckLine } from "./receipts";

export interface VoteRow {
  pot: string;
  kind: number;
  data: string;
  nonce: string;
  epoch: bigint;
  deadline: number;
  status: string;
  txHash: string | null;
}

export interface VoteReceiptDeps {
  chainId: number;
  rpcUrl: string;
  /** The vote's own fields (no Telegram column), or null when the API does not know this vote. */
  vote(digest: Hex): Promise<VoteRow | null>;
  /** Its approvals, withdrawn ones included. */
  approvals(digest: Hex): Promise<{ signer: string; signature: string; revoked: boolean }[]>;
  /** Whether the signature is valid for that key now (EOA or ERC-1271 account). */
  verify(signer: Address, envelope: ProposalEnvelope, signature: Hex): Promise<boolean>;
}

const STATE: Record<string, string> = { collecting: "open", ready: "ready", queued: "queued", executed: "executed", expired: "expired", stale: "stale", failed: "failed" };

export interface VoteReceipt {
  kind: "vote";
  chainId: number;
  digest: Hex;
  digestMatches: boolean;
  pot: Address;
  action: string;
  state: string;
  txHash: string | null;
  signed: { domain: { name: string; version: string; chainId: number; verifyingContract: Address }; primaryType: "Proposal"; types: unknown; message: { kind: number; data: Hex; nonce: string; epoch: string; deadline: string } };
  approvals: { signer: Address; signature: Hex; withdrawn: boolean; stillValid: boolean | null }[];
  checks: CheckLine[];
}

export async function voteReceipt(digest: Hex, d: VoteReceiptDeps): Promise<VoteReceipt | null> {
  const v = await d.vote(digest);
  if (!v) return null;
  const pot = getAddress(v.pot);
  const env: ProposalEnvelope = { pot, chainId: d.chainId, kind: v.kind as Kind, data: v.data as Hex, nonce: BigInt(v.nonce), epoch: BigInt(v.epoch), deadline: BigInt(v.deadline) };
  const td = typedData(env);
  const again = proposalDigest(env);
  const approvals = await Promise.all(
    (await d.approvals(digest)).map(async (a) => {
      let stillValid: boolean | null = null;
      if (!a.revoked) stillValid = await d.verify(getAddress(a.signer), env, a.signature as Hex).catch(() => null);
      return { signer: getAddress(a.signer), signature: a.signature as Hex, withdrawn: a.revoked, stillValid };
    }),
  );
  return {
    kind: "vote",
    chainId: d.chainId,
    digest,
    digestMatches: again.toLowerCase() === digest.toLowerCase(),
    pot,
    action: KIND_NAMES[v.kind] ?? `action ${v.kind}`,
    state: STATE[v.status] ?? v.status,
    txHash: v.txHash,
    signed: { domain: td.domain, primaryType: "Proposal", types: td.types, message: { kind: v.kind, data: env.data, nonce: env.nonce.toString(), epoch: env.epoch.toString(), deadline: env.deadline.toString() } },
    approvals,
    checks: [
      { what: "The group account hashes the same fields to the same digest", command: castCall(d.rpcUrl, pot, "hashProposal(uint8,bytes,uint256,uint64,uint64)(bytes32)", [v.kind, env.data, env.nonce, env.epoch, env.deadline]) },
      { what: "The signing domain the digest uses (name Cofer, version 1, this chain, this group account)", command: castCall(d.rpcUrl, pot, "domainSeparator()(bytes32)", []) },
      { what: "With the SDK or viem: hashTypedData(signed) gives the digest", command: "const m = receipt.signed.message; hashTypedData({ ...receipt.signed, message: { ...m, nonce: BigInt(m.nonce), epoch: BigInt(m.epoch), deadline: BigInt(m.deadline) } })" },
    ],
  };
}
