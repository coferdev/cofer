/**
 * verifyReceipt: checks a Cofer receipt (exit, deposit, allowance spend or vote, as /v1/receipts/... answers) against
 * the chain, through an RPC you choose, and names every line that does not match. Read-only: it never signs.
 *   - exit, deposit, spend: the transaction's own logs from the group account are read again and every figure in the
 *     receipt is compared with them;
 *   - vote: the digest is made again from the signed message and asked of the group account (hashProposal), and every
 *     approval not withdrawn is verified again (EOA or ERC-1271 account).
 */
import { createPublicClient, decodeEventLog, getAddress, hashTypedData, http, type Address, type Hex } from "viem";

export const RECEIPT_EVENTS = [
  { type: "event", name: "Exited", inputs: [{ name: "member", type: "address", indexed: true }, { name: "to", type: "address", indexed: true }, { name: "shares", type: "uint256", indexed: false }, { name: "assets", type: "address[]", indexed: false }, { name: "amounts", type: "uint256[]", indexed: false }] },
  { type: "event", name: "ExitOwed", inputs: [{ name: "asset", type: "address", indexed: true }, { name: "account", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false }] },
  { type: "event", name: "Deposited", inputs: [{ name: "member", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false }, { name: "shares", type: "uint256", indexed: false }, { name: "navBefore", type: "uint256", indexed: false }] },
  { type: "event", name: "AllowanceSpent", inputs: [{ name: "member", type: "address", indexed: true }, { name: "to", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false }, { name: "memo", type: "bytes32", indexed: false }, { name: "remaining", type: "uint256", indexed: false }] },
] as const;

const HASH_PROPOSAL = [{ type: "function", name: "hashProposal", stateMutability: "view", inputs: [{ name: "kind", type: "uint8" }, { name: "data", type: "bytes" }, { name: "nonce", type: "uint256" }, { name: "epoch_", type: "uint64" }, { name: "deadline", type: "uint64" }], outputs: [{ type: "bytes32" }] }] as const;

/** What verifyReceipt needs from the chain (a viem public client works). */
export interface ChainReader {
  getTransactionReceipt(a: { hash: Hex }): Promise<{ blockNumber: bigint; status: "success" | "reverted"; logs: { address: Address; topics: readonly Hex[]; data: Hex }[] }>;
  readContract(a: { address: Address; abi: typeof HASH_PROPOSAL; functionName: "hashProposal"; args: readonly [number, Hex, bigint, bigint, bigint] }): Promise<Hex>;
  verifyTypedData(a: { address: Address; signature: Hex; domain: unknown; types: unknown; primaryType: "Proposal"; message: unknown }): Promise<boolean>;
}

export interface CheckResult {
  line: string;
  expected: string;
  actual: string;
  ok: boolean;
}

export interface Verdict {
  ok: boolean;
  checked: CheckResult[];
  /** Only the lines that failed, for a short answer. */
  failed: CheckResult[];
}

type Any = Record<string, any>;
const same = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();

function verdict(checked: CheckResult[]): Verdict {
  const failed = checked.filter((c) => !c.ok);
  return { ok: failed.length === 0 && checked.length > 0, checked, failed };
}

/** The receipt itself, or the API's whole answer ({ data: receipt }). */
const unwrap = (r: Any): Any => (r && typeof r === "object" && "data" in r && r.data?.kind ? r.data : r);

export async function verifyReceipt(receipt: Any, rpc: string | ChainReader): Promise<Verdict> {
  const r = unwrap(receipt);
  const chain = (typeof rpc === "string" ? createPublicClient({ transport: http(rpc) }) : rpc) as ChainReader;
  const out: CheckResult[] = [];
  const line = (name: string, expected: unknown, actual: unknown) => out.push({ line: name, expected: String(expected), actual: String(actual), ok: same(expected, actual) });

  if (r.kind === "vote") {
    const m = r.signed?.message ?? {};
    const msg = { kind: Number(m.kind), data: m.data as Hex, nonce: BigInt(m.nonce), epoch: BigInt(m.epoch), deadline: BigInt(m.deadline) };
    let again = "could not be computed";
    try {
      again = hashTypedData({ domain: r.signed.domain, types: r.signed.types, primaryType: "Proposal", message: msg } as never);
    } catch {
      /* stays as the text above */
    }
    line("digest made again from the signed message", r.digest, again);
    try {
      const onchain = await chain.readContract({ address: getAddress(r.pot), abi: HASH_PROPOSAL, functionName: "hashProposal", args: [msg.kind, msg.data, msg.nonce, msg.epoch, msg.deadline] });
      line("the group account's hashProposal of the same fields", r.digest, onchain);
    } catch {
      line("the group account's hashProposal of the same fields", r.digest, "the group account could not be read");
    }
    for (const a of r.approvals ?? []) {
      if (a.withdrawn) continue;
      const ok = await chain.verifyTypedData({ address: getAddress(a.signer), signature: a.signature, domain: r.signed.domain, types: r.signed.types, primaryType: "Proposal", message: msg }).catch(() => false);
      line(`approval by ${a.signer} still valid`, a.stillValid, ok);
    }
    return verdict(out);
  }

  const tx = await chain.getTransactionReceipt({ hash: r.tx }).catch(() => null);
  if (!tx) return verdict([{ line: "the transaction exists on this chain", expected: String(r.tx), actual: "not found", ok: false }]);
  line("block", r.block, tx.blockNumber);
  line("transaction succeeded", "success", tx.status);
  const logs = tx.logs
    .filter((l) => same(l.address, r.pot))
    .flatMap((l) => {
      try {
        return [decodeEventLog({ abi: RECEIPT_EVENTS, data: l.data, topics: l.topics as [Hex, ...Hex[]] }) as unknown as { eventName: string; args: Any }];
      } catch {
        return [];
      }
    });
  const find = (name: string) => logs.find((l) => l.eventName === name)?.args;

  if (r.kind === "exit") {
    const x = find("Exited");
    if (!x) return verdict([...out, { line: "an Exited log from the group account", expected: "present", actual: "missing", ok: false }]);
    line("member", r.member, x.member);
    line("destination", r.to, x.to);
    line("shares burned", r.sharesBurned, x.shares);
    line("number of tokens", (r.assets ?? []).length, x.assets.length);
    (r.assets ?? []).forEach((a: Any, i: number) => {
      line(`token ${i + 1}`, a.asset, x.assets[i]);
      line(`token ${i + 1} amount`, a.amount, x.amounts[i]);
      const owed = logs.filter((l) => l.eventName === "ExitOwed" && same(l.args.asset, a.asset)).reduce((s, l) => s + BigInt(l.args.amount), 0n);
      line(`token ${i + 1} set aside`, a.setAside, owed);
      line(`token ${i + 1} sent`, a.sent, BigInt(x.amounts[i] ?? 0n) - owed);
    });
  } else if (r.kind === "deposit") {
    const x = find("Deposited");
    if (!x) return verdict([...out, { line: "a Deposited log from the group account", expected: "present", actual: "missing", ok: false }]);
    line("member", r.member, x.member);
    line("amount", r.amount, x.amount);
    line("shares minted", r.sharesMinted, x.shares);
    line("the group's total before", r.groupTotalBefore, x.navBefore);
  } else if (r.kind === "spend") {
    const x = find("AllowanceSpent");
    if (!x) return verdict([...out, { line: "an AllowanceSpent log from the group account", expected: "present", actual: "missing", ok: false }]);
    line("spender", r.spender, x.member);
    line("recipient", r.to, x.to);
    line("amount", r.amount, x.amount);
    line("memo", r.memo, x.memo);
    line("allowance left", r.allowanceLeft, x.remaining);
  } else {
    return verdict([{ line: "a known receipt kind (exit, deposit, spend, vote)", expected: "exit | deposit | spend | vote", actual: String(r.kind), ok: false }]);
  }
  return verdict(out);
}

/** The verdict as plain lines. */
export function verdictText(v: Verdict): string {
  if (v.ok) return `Receipt matches the chain (${v.checked.length} lines checked).`;
  return [`Receipt does NOT match the chain: ${v.failed.length} of ${v.checked.length} lines differ.`, ...v.failed.map((f) => `- ${f.line}: receipt says ${f.expected}, the chain says ${f.actual}`)].join("\n");
}
