import { describe, expect, test } from "bun:test";
import { type Hex, concat, encodeAbiParameters, keccak256 } from "viem";
import { LogChain, headOf, payoutTree, standingsTree } from "../src/arena/log/chain";
import { decodeLogEvent, decodeOrder, encodeLogEvent, encodeOrder } from "../src/arena/log/events";
import { MerkleTree, PAYOUT_TAG, hashPair, processProof } from "../src/arena/log/merkle";
import type { Order } from "../src/arena/engine/orders";

const TABLE = "0x00000000000000000000000000000000000000aa" as Hex;
const RULES = keccak256("0x01");
const seat = (i: number) => `0x${i.toString(16).padStart(40, "0")}` as Hex;

describe("arena log", () => {
  test("events round-trip through their ABI layout", () => {
    const e = { type: "Fill" as const, seq: 7n, payload: ["c1", 1_800_000_002_000n, "BTC", "PERP", -5_000_000n, 10_000_000_000_000n, 2_500n, -12n] };
    const d = decodeLogEvent(encodeLogEvent(e));
    expect(d.type).toBe("Fill");
    expect(d.seq).toBe(7n);
    expect([...d.payload]).toEqual(e.payload);
  });

  test("orders round-trip through the canonical bytes; another table gives other bytes", () => {
    const o: Order = {
      seat: seat(1), nonce: 3n, kind: "OPT_BUY", symbol: "BTC", product: "OPTION", clientId: "x9",
      option: { type: "PUT", strike: 9_950_000_000_000n, expiry: 1_800_003_600_000, contracts: 4n }, validUntil: 1_800_000_060_000,
    };
    const enc = encodeOrder(TABLE, o);
    expect(decodeOrder(enc)).toEqual({ table: TABLE, order: o });
    expect(encodeOrder(seat(0xbb), o)).not.toBe(enc);
  });

  test("the chain head is h_N, recomputable from the encoded events; one changed byte changes it", () => {
    const c = new LogChain(4663, TABLE, RULES);
    const enc = [1, 2, 3].map((i) => encodeLogEvent({ type: "Checkpoint", seq: BigInt(i), payload: [BigInt(i), keccak256(`0x0${i}`)] }));
    for (const x of enc) c.append(x);
    expect(headOf(4663, TABLE, RULES, enc)).toBe(c.head);
    const bad = [...enc];
    bad[1] = `${bad[1]!.slice(0, -2)}ff` as Hex;
    expect(headOf(4663, TABLE, RULES, bad)).not.toBe(c.head);
    expect(headOf(46630, TABLE, RULES, enc)).not.toBe(c.head); // another chain id, another chain
  });

  test("every leaf's proof verifies to the root (1 to 33 leaves), and a wrong leaf does not", () => {
    for (let n = 1; n <= 33; n++) {
      const leaves = Array.from({ length: n }, (_, i) => keccak256(`0x${(i + 1).toString(16).padStart(4, "0")}`));
      const t = new MerkleTree(leaves);
      for (let i = 0; i < n; i++) expect(processProof(t.proof(i), leaves[i]!)).toBe(t.root);
      if (n > 1) expect(processProof(t.proof(0), leaves[1]!)).not.toBe(t.root);
    }
  });

  test("payout proofs match what TableEscrow.claimPrize checks (leaf and sorted-pair path written out here)", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ index: i, account: seat(i + 1), amount: BigInt((10 - i) * 1_000_000) }));
    const t = payoutTree(4663, TABLE, rows);
    for (const r of rows) {
      // the contract: keccak256(bytes.concat(keccak256(abi.encode(PAYOUT_TAG, chainid, this, index, msg.sender, amount))))
      const inner = keccak256(encodeAbiParameters(
        [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }],
        [PAYOUT_TAG, 4663n, TABLE, BigInt(r.index), r.account, r.amount],
      ));
      let h = keccak256(inner);
      for (const p of t.proof(r.index)) h = BigInt(h) < BigInt(p) ? keccak256(concat([h, p])) : keccak256(concat([p, h]));
      expect(h).toBe(t.root);
    }
    expect(PAYOUT_TAG).toBe(keccak256(new TextEncoder().encode("COFER_ARENA_PAYOUT_V1")));
    // another chain or table gives another root, so a leaf can never verify elsewhere
    expect(payoutTree(46630, TABLE, rows).root).not.toBe(t.root);
  });

  test("the events tree and the standings tree build and prove", () => {
    const c = new LogChain(4663, TABLE, RULES);
    for (let i = 0; i < 5; i++) c.append(encodeLogEvent({ type: "Halt", seq: BigInt(i), payload: ["BTC", "DIVERGED"] }));
    const et = c.eventsTree();
    expect(et.proof(4).length).toBeGreaterThan(0);
    const st = standingsTree(4663, TABLE, [
      { rank: 1, seat: seat(1), finalEquity: 12_000_000_000n, maxDrawdownBps: 100n, score1e6: 195_000n, activityOk: true, eliminatedAt: null, flags: 0 },
      { rank: 2, seat: seat(2), finalEquity: 0n, maxDrawdownBps: 10_000n, score1e6: -1_000_000n, activityOk: true, eliminatedAt: 1_800_000_100_000, flags: 1 },
    ]);
    expect(processProof(st.proof(1), st.leaves[1]!)).toBe(st.root);
    expect(hashPair(st.leaves[0]!, st.leaves[1]!)).toBe(st.root);
  });
});
