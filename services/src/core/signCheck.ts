/**
 * Checks the signer page runs on a vote BEFORE the passkey is asked for (audit finding M-2).
 * The server sends the typed data, its decoded action and a summary. None of that is trusted here:
 *  - the domain must be Cofer v1 on the page's own chain;
 *  - the page rebuilds the envelope itself, recomputes the EIP-712 digest and requires it to equal
 *    the vote id in the member's one-time link;
 *  - the page decodes the proposal bytes itself, requires them to be the canonical encoding, and
 *    requires the server's decoded action to match field by field;
 *  - the deadline must still be in the future.
 * The page then signs the typed data it built (never the server's object) and shows a summary
 * rendered from those same bytes. Pure: no network, no DOM (the on-chain isPot check is in client.ts).
 *
 * Limit: this protects against tampered server data. It cannot protect against a replaced page
 * script, which could skip these checks (see SECURITY.md).
 */
import { getAddress, isAddress, type Address, type Hex } from "viem";
import {
  DOMAIN_NAME,
  DOMAIN_VERSION,
  PROPOSAL_TYPES,
  decodeAction,
  describe,
  encodeAction,
  proposalDigest,
  type Action,
  type ProposalEnvelope,
  type TokenMeta,
} from "./proposal";

/** What the member reads when a check fails. Nothing is signed. */
export const VOTE_MISMATCH_TEXT = "This vote does not match what was shown. Nothing was signed. Tell the group and do not approve it.";

export interface ServerTypedData {
  domain: { name?: unknown; version?: unknown; chainId?: unknown; verifyingContract?: unknown };
  types?: unknown;
  primaryType?: unknown;
  message: { kind?: unknown; data?: unknown; nonce?: unknown; epoch?: unknown; deadline?: unknown };
}

export type SignCheck = { ok: true; envelope: ProposalEnvelope; action: Action } | { ok: false; problem: string };

const fail = (problem: string): SignCheck => ({ ok: false, problem });

/** Stable text form for comparing two decoded actions: bigints as strings, hex lower-cased, keys sorted. */
export function canonicalAction(a: unknown): string {
  const norm = (v: unknown): unknown => {
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "string") return /^0x[0-9a-fA-F]*$/.test(v) ? v.toLowerCase() : v;
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, norm((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(norm(a));
}

function toBig(v: unknown): bigint | null {
  if (typeof v === "bigint") return v;
  if ((typeof v === "string" && /^\d+$/.test(v)) || (typeof v === "number" && Number.isSafeInteger(v) && v >= 0)) return BigInt(v);
  return null;
}

export function checkBeforeSign(i: {
  typedData: ServerTypedData;
  serverAction: unknown;
  expectedDigest: string;
  chainId: number;
  nowSec: number;
}): SignCheck {
  const { domain, message } = i.typedData;
  if (domain.name !== DOMAIN_NAME || domain.version !== DOMAIN_VERSION) return fail("domain is not Cofer v1");
  if (Number(domain.chainId) !== i.chainId) return fail("wrong chain");
  if (typeof domain.verifyingContract !== "string" || !isAddress(domain.verifyingContract)) return fail("bad pot address");
  if (i.typedData.primaryType !== "Proposal" || JSON.stringify(i.typedData.types) !== JSON.stringify(PROPOSAL_TYPES)) return fail("wrong typed-data types");

  const kind = Number(message.kind);
  const nonce = toBig(message.nonce);
  const epoch = toBig(message.epoch);
  const deadline = toBig(message.deadline);
  if (!Number.isInteger(kind) || kind < 0 || kind > 255 || nonce === null || epoch === null || deadline === null) return fail("malformed message");
  if (typeof message.data !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(message.data)) return fail("malformed data");
  if (deadline <= BigInt(i.nowSec)) return fail("vote has expired");

  const envelope: ProposalEnvelope = {
    pot: getAddress(domain.verifyingContract),
    chainId: i.chainId,
    kind,
    data: message.data as Hex,
    nonce,
    epoch,
    deadline,
  };
  if (proposalDigest(envelope).toLowerCase() !== i.expectedDigest.toLowerCase()) return fail("digest does not match the vote link");

  let action: Action;
  try {
    action = decodeAction(kind, envelope.data);
    if (encodeAction(action).data.toLowerCase() !== envelope.data.toLowerCase()) return fail("data is not the canonical encoding");
  } catch {
    return fail("data does not decode");
  }
  if (canonicalAction(action) !== canonicalAction(i.serverAction)) return fail("server action does not match the signed data");
  return { ok: true, envelope, action };
}

/** Tokens whose symbol/decimals the summary needs (read on-chain by the page). */
export function tokensOf(a: Action): Address[] {
  if (a.kind === 0) return [a.asset];
  if (a.kind === 1) return [a.tokenIn, a.tokenOut];
  return [];
}

/** The summary the member reads: rendered from the signed bytes, every address in full. */
export function pageSummary(a: Action, tokens: (addr: Address) => TokenMeta): string {
  return describe(a, tokens, (addr) => getAddress(addr));
}
