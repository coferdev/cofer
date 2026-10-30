/**
 * Signer API core: create proposals, serve EIP-712 typed data, collect and verify member
 * signatures, and hand ready proposals to the relayer. The contract re-checks everything; this
 * layer exists so people never sign something that would revert.
 */
import { and, eq } from "drizzle-orm";
import { getAddress, type Address, type Hex, type PublicClient } from "viem";
import { schema, type DB } from "../db/client";
import { potAbi, factoryAbi } from "../chain/clients";
import {
  Kind,
  LIMITS,
  decodeAction,
  describe,
  encodeAction,
  proposalDigest,
  randomNonce,
  typedData,
  type Action,
  type ProposalEnvelope,
  type TokenMeta,
} from "../core/proposal";
import { tally, packVotes, type Vote, type PotRules, type Tally } from "../core/votes";
import { groupCanBuyStocks } from "../core/geo";
import { UserError } from "../core/errors";

export interface ProposalDeps {
  db: DB;
  client: PublicClient;
  chainId: number;
  factory: Address;
  tokens: (a: Address) => TokenMeta;
  names: (a: Address) => string;
  enqueueRelay: (proposalId: Hex) => Promise<void>;
  notify: (proposalId: Hex) => Promise<void>;
}

export async function readRules(client: PublicClient, pot: Address): Promise<PotRules & { epoch: bigint }> {
  const [members, threshold, thresholdBps, config, epoch] = await Promise.all([
    client.readContract({ address: pot, abi: potAbi, functionName: "members" }),
    client.readContract({ address: pot, abi: potAbi, functionName: "threshold" }),
    client.readContract({ address: pot, abi: potAbi, functionName: "thresholdBps" }),
    client.readContract({ address: pot, abi: potAbi, functionName: "config" }),
    client.readContract({ address: pot, abi: potAbi, functionName: "epoch" }),
  ]);
  return {
    members: [...members],
    threshold: Number(threshold),
    thresholdBps: Number(thresholdBps),
    guardDelay: Number(config[0]),
    epoch,
  };
}

/** Fixed text written for members (a UserError), so it is safe to show in the chat. */
export class ProposalError extends UserError {}

export async function createProposal(
  deps: ProposalDeps,
  args: { pot: Address; action: Action; proposerTg: number; ttlSec?: number },
) {
  const { db, client } = deps;
  const pot = getAddress(args.pot);
  const potRow = await db.query.pots.findFirst({ where: eq(schema.pots.address, pot) });
  if (!potRow) throw new ProposalError("unknown pot");

  const proposer = await db.query.users.findFirst({ where: eq(schema.users.tgId, args.proposerTg) });
  const rules = await readRules(client, pot);
  const a = args.action;
  const isMember = !!proposer?.address && rules.members.some((m) => m.toLowerCase() === proposer.address!.toLowerCase());
  // a linked non-member may only ask to be added themselves (members still have to vote)
  const selfJoin = !!proposer?.address && a.kind === Kind.ADD_MEMBER && a.member.toLowerCase() === proposer.address.toLowerCase();
  if (!isMember && !selfJoin) throw new ProposalError("only members can propose");

  // Pre-flight checks that mirror the contract (fail before anyone signs).
  if (a.kind === Kind.SWAP) {
    const buyable = await client.readContract({ address: deps.factory, abi: factoryAbi, functionName: "isBuyable", args: [a.tokenOut] });
    if (!buyable) throw new ProposalError("that asset is not on the list");
    const info = await client.readContract({ address: deps.factory, abi: factoryAbi, functionName: "assetInfo", args: [a.tokenOut] });
    if (info.isStock) {
      const regions = await memberRegions(db, rules.members);
      const gate = groupCanBuyStocks(regions);
      if (!gate.allowed) {
        throw new ProposalError(
          `stock buys are off for this group (${gate.blockedMembers} member(s) in excluded regions, ${gate.undeclaredMembers} undeclared)`,
        );
      }
    }
  }
  if (a.kind === Kind.ADD_MEMBER && rules.members.some((m) => m.toLowerCase() === a.member.toLowerCase())) {
    throw new ProposalError("already a member");
  }

  const { kind, data } = encodeAction(a);
  const ttl = Math.min(args.ttlSec ?? 3 * 24 * 3600, LIMITS.MAX_TTL_SECONDS);
  // deadline must outlive the exit window, so a passed vote can still execute after it
  const deadline = BigInt(Math.floor(Date.now() / 1000) + ttl + rules.guardDelay);
  const env: ProposalEnvelope = { pot, chainId: deps.chainId, kind, data, nonce: randomNonce(), epoch: rules.epoch, deadline };
  const id = proposalDigest(env);
  const summary = describe(a, deps.tokens, deps.names);

  await db.insert(schema.proposals).values({
    id,
    pot,
    kind,
    data,
    nonce: env.nonce.toString(),
    epoch: env.epoch,
    deadline: Number(deadline),
    summary,
    proposerTg: args.proposerTg,
  });
  await deps.notify(id);
  return { id, summary, typedData: serializeTypedData(env) };
}

export async function getSignable(deps: Pick<ProposalDeps, "db" | "client">, id: Hex) {
  const row = await deps.db.query.proposals.findFirst({ where: eq(schema.proposals.id, id) });
  if (!row) throw new ProposalError("unknown proposal");
  const env = envelopeFromRow(row, (await deps.client.getChainId()) as number);
  const rules = await readRules(deps.client, env.pot);
  const sigs = await deps.db.query.signatures.findMany({ where: eq(schema.signatures.proposalId, id) });
  const t = tally(rules, env.kind, sigs.map(toVote), revokedSet(sigs));
  return {
    id,
    status: row.status,
    summary: row.summary,
    action: jsonSafe(decodeAction(env.kind, env.data)),
    typedData: serializeTypedData(env),
    tally: t,
    stale: env.epoch !== rules.epoch,
  };
}

/**
 * Accepts a signature only if: the Telegram user is bound to `signer`, the signer is a current
 * member, and the signature verifies for the digest (viem verifyTypedData supports EOAs, ERC-1271
 * smart accounts and ERC-6492 counterfactual accounts).
 */
export async function addSignature(
  deps: ProposalDeps,
  args: { id: Hex; tgId: number; signer: Address; signature: Hex },
): Promise<Tally> {
  const { db, client } = deps;
  const row = await db.query.proposals.findFirst({ where: eq(schema.proposals.id, args.id) });
  if (!row) throw new ProposalError("unknown proposal");
  if (row.status !== "collecting" && row.status !== "ready") throw new ProposalError(`proposal is ${row.status}`);
  if (row.deadline < Math.floor(Date.now() / 1000)) throw new ProposalError("proposal expired");

  const user = await db.query.users.findFirst({ where: eq(schema.users.tgId, args.tgId) });
  const signer = getAddress(args.signer);
  if (!user?.address || getAddress(user.address) !== signer) throw new ProposalError("signer is not linked to this Telegram account");

  const env = envelopeFromRow(row, deps.chainId);
  const rules = await readRules(client, env.pot);
  if (env.epoch !== rules.epoch) {
    await db.update(schema.proposals).set({ status: "stale" }).where(eq(schema.proposals.id, args.id));
    throw new ProposalError("group settings changed; this vote needs to be re-proposed");
  }
  if (!rules.members.some((m) => getAddress(m) === signer)) throw new ProposalError("not a member");

  const ok = await client.verifyTypedData({ address: signer, signature: args.signature, ...typedData(env) });
  if (!ok) throw new ProposalError("signature does not match this proposal");

  await db
    .insert(schema.signatures)
    .values({ proposalId: args.id, signer, signature: args.signature })
    .onConflictDoUpdate({
      target: [schema.signatures.proposalId, schema.signatures.signer],
      set: { signature: args.signature, revoked: false, verifiedAt: new Date() },
    });

  const sigs = await db.query.signatures.findMany({ where: eq(schema.signatures.proposalId, args.id) });
  const t = tally(rules, env.kind, sigs.map(toVote), revokedSet(sigs));
  if (t.ready && row.status === "collecting") {
    await db.update(schema.proposals).set({ status: "ready" }).where(eq(schema.proposals.id, args.id));
    await deps.enqueueRelay(args.id);
  }
  await deps.notify(args.id);
  return t;
}

/** Calldata for CoferPot.execute, built only from counted (member, non-revoked) votes. */
export async function buildExecuteArgs(deps: Pick<ProposalDeps, "db" | "client" | "chainId">, id: Hex) {
  const row = await deps.db.query.proposals.findFirst({ where: eq(schema.proposals.id, id) });
  if (!row) throw new ProposalError("unknown proposal");
  const env = envelopeFromRow(row, deps.chainId);
  const rules = await readRules(deps.client, env.pot);
  const sigs = await deps.db.query.signatures.findMany({
    where: and(eq(schema.signatures.proposalId, id), eq(schema.signatures.revoked, false)),
  });
  const votes = sigs.map(toVote);
  const t = tally(rules, env.kind, votes);
  if (!t.ready) throw new ProposalError(`not enough votes (${t.approvals}/${t.required})`);
  const packed = packVotes(votes, t.counted);
  return {
    pot: env.pot,
    args: [env.kind, env.data, env.nonce, env.epoch, env.deadline, packed] as const,
    tally: t,
  };
}

// ---------------------------------------------------------------- helpers

export function envelopeFromRow(
  row: { pot: string; kind: number; data: string; nonce: string; epoch: bigint; deadline: number },
  chainId: number,
): ProposalEnvelope {
  return {
    pot: getAddress(row.pot),
    chainId,
    kind: row.kind as Kind,
    data: row.data as Hex,
    nonce: BigInt(row.nonce),
    epoch: BigInt(row.epoch),
    deadline: BigInt(row.deadline),
  };
}

export function serializeTypedData(env: ProposalEnvelope) {
  const td = typedData(env);
  return {
    ...td,
    message: {
      kind: td.message.kind,
      data: td.message.data,
      nonce: td.message.nonce.toString(),
      epoch: td.message.epoch.toString(),
      deadline: td.message.deadline.toString(),
    },
  };
}

function toVote(s: { signer: string; signature: string }): Vote {
  return { signer: getAddress(s.signer), signature: s.signature as Hex };
}

function revokedSet(sigs: { signer: string; revoked: boolean }[]) {
  return new Set(sigs.filter((s) => s.revoked).map((s) => s.signer.toLowerCase()));
}

async function memberRegions(db: DB, members: readonly Address[]) {
  const rows = await db.query.users.findMany();
  const byAddr = new Map(rows.filter((r) => r.address).map((r) => [r.address!.toLowerCase(), r.region]));
  return members.map((m) => ({ declared: byAddr.get(m.toLowerCase()) ?? null }));
}

function jsonSafe<T>(v: T): unknown {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
}
