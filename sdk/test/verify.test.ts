import { describe, expect, test } from "bun:test";
import { hashTypedData, type Address, type Hex } from "viem";
import recorded from "../../services/test/fixtures/tx-receipts-46630.json";
import { verdictText, verifyReceipt, type ChainReader } from "../src/verify";

/** A chain that answers from the recorded testnet receipts (and a fixed hashProposal and signature check). */
function chain(o: { hash?: Hex; valid?: (a: Address) => boolean } = {}): ChainReader {
  return {
    getTransactionReceipt: async ({ hash }) => {
      const r = recorded.receipts.find((x) => x.transactionHash === hash);
      if (!r) throw new Error("not found");
      return { blockNumber: BigInt(r.blockNumber), status: r.status as "success", logs: r.logs as never };
    },
    readContract: async () => o.hash ?? ("0x" as Hex),
    verifyTypedData: async ({ address }) => (o.valid ?? (() => true))(address),
  };
}
const blockOf = (h: string) => recorded.receipts.find((r) => r.transactionHash === h)!.blockNumber;
const POT = "0x50F19AdD1EE10AF538C1F8bE5bcbA4011F100115";
const KEY = "0xD6D8195a52Fa752A5bBaf76b598336FecAc9c585";
const USDG = "0x14119629e364A53ceda500d0c1111DBB136A7398";

const exit = { kind: "exit", tx: recorded.kinds.Exited, block: blockOf(recorded.kinds.Exited), pot: POT, member: KEY, to: KEY, sharesBurned: "100000000000000000000", assets: [{ asset: USDG, amount: "90000000", sent: "90000000", setAside: "0" }] };
const deposit = { kind: "deposit", tx: recorded.kinds.Deposited, block: blockOf(recorded.kinds.Deposited), pot: POT, member: KEY, amount: "100000000", sharesMinted: "100000000000000000000", groupTotalBefore: "0" };

describe("verifyReceipt", () => {
  test("a true exit receipt passes, also wrapped as the API answers it", async () => {
    expect((await verifyReceipt(exit, chain())).ok).toBe(true);
    expect((await verifyReceipt({ data: exit, meta: {} }, chain())).ok).toBe(true);
  });

  test("each tampered exit field is named", async () => {
    const cases: [string, Record<string, unknown>][] = [
      ["member", { member: USDG }],
      ["destination", { to: USDG }],
      ["shares burned", { sharesBurned: "1" }],
      ["block", { block: "1" }],
      ["token 1 amount", { assets: [{ ...exit.assets[0], amount: "1" }] }],
      ["token 1 set aside", { assets: [{ ...exit.assets[0], setAside: "5" }] }],
      ["token 1 sent", { assets: [{ ...exit.assets[0], sent: "5" }] }],
    ];
    for (const [line, change] of cases) {
      const v = await verifyReceipt({ ...exit, ...change }, chain());
      expect(v.ok).toBe(false);
      expect(v.failed.map((f) => f.line)).toContain(line);
    }
  });

  test("a deposit receipt: true passes, a changed figure fails on its own line", async () => {
    expect((await verifyReceipt(deposit, chain())).ok).toBe(true);
    const v = await verifyReceipt({ ...deposit, sharesMinted: "99" }, chain());
    expect(v.failed.map((f) => f.line)).toEqual(["shares minted"]);
    expect(verdictText(v)).toBe("Receipt does NOT match the chain: 1 of 6 lines differ.\n- shares minted: receipt says 99, the chain says 100000000000000000000");
  });

  test("an allowance spend receipt", async () => {
    const tx = recorded.receipts.find((r) => r.transactionHash === recorded.kinds.AllowanceSpent)!;
    const pot = "0x867851A44059BC0dB4202E78ecdC97bF55d8776e";
    const log = tx.logs.find((l) => l.address.toLowerCase() === pot.toLowerCase())!;
    const memo = `0x${log.data.slice(2 + 64 * 1, 2 + 64 * 2)}`;
    const spend = { kind: "spend", tx: tx.transactionHash, block: tx.blockNumber, pot, spender: "0x8251FA75f4982cDCB4bE015B9F7Ba20116a1596C", to: "0x215Ea29bE890960586CEc7e35B381F6599f955aa", amount: "2000000", memo, allowanceLeft: "3000000" };
    expect((await verifyReceipt(spend, chain())).ok).toBe(true);
    expect((await verifyReceipt({ ...spend, allowanceLeft: "4000000" }, chain())).failed.map((f) => f.line)).toEqual(["allowance left"]);
  });

  test("a receipt for a transaction the chain does not have fails plainly", async () => {
    const v = await verifyReceipt({ ...exit, tx: `0x${"00".repeat(32)}` }, chain());
    expect(v.failed[0]!.line).toBe("the transaction exists on this chain");
  });

  test("a vote receipt: the digest is made again and asked of the group account; approvals verified again", async () => {
    const signed = {
      domain: { name: "Cofer", version: "1", chainId: 4663, verifyingContract: "0x000000000000000000000000000000000000c0Fe" },
      primaryType: "Proposal",
      types: { Proposal: [{ name: "kind", type: "uint8" }, { name: "data", type: "bytes" }, { name: "nonce", type: "uint256" }, { name: "epoch", type: "uint64" }, { name: "deadline", type: "uint64" }] },
      message: { kind: 0, data: "0x1234", nonce: "42", epoch: "7", deadline: "2000000000" },
    };
    const digest = hashTypedData({ ...signed, message: { ...signed.message, nonce: 42n, epoch: 7n, deadline: 2_000_000_000n } } as never);
    const vote = { kind: "vote", digest, pot: signed.domain.verifyingContract, signed, approvals: [{ signer: KEY, signature: "0x01", withdrawn: false, stillValid: true }, { signer: USDG, signature: "0x02", withdrawn: true, stillValid: null }] };
    expect((await verifyReceipt(vote, chain({ hash: digest }))).ok).toBe(true);
    const wrongOnChain = await verifyReceipt(vote, chain({ hash: `0x${"11".repeat(32)}` }));
    expect(wrongOnChain.failed.map((f) => f.line)).toEqual(["the group account's hashProposal of the same fields"]);
    const tampered = await verifyReceipt({ ...vote, signed: { ...signed, message: { ...signed.message, nonce: "43" } } }, chain({ hash: digest }));
    expect(tampered.failed.map((f) => f.line)).toContain("digest made again from the signed message");
    const revokedKey = await verifyReceipt(vote, chain({ hash: digest, valid: () => false }));
    expect(revokedKey.failed.map((f) => f.line)).toEqual([`approval by ${KEY} still valid`]);
  });

  test("an unknown receipt kind is refused", async () => {
    expect((await verifyReceipt({ kind: "other" }, chain())).ok).toBe(false);
  });
});
