/**
 * Merkle trees in the OpenZeppelin StandardMerkleTree layout (spec §4.7): leaf = keccak256(keccak256(abi.encode(...))),
 * leaves sorted by hash, sorted-pair keccak256 nodes. A proof from here verifies with OpenZeppelin
 * MerkleProof.processProof, which is what TableEscrow.claimPrize runs.
 */
import { type Hex, concat, encodeAbiParameters, keccak256 } from "viem";

export const EVENT_TAG = keccak256(new TextEncoder().encode("COFER_ARENA_EVENT_V1"));
export const STANDING_TAG = keccak256(new TextEncoder().encode("COFER_ARENA_STANDING_V1"));
export const PAYOUT_TAG = keccak256(new TextEncoder().encode("COFER_ARENA_PAYOUT_V1"));

export const EVENT_LEAF = ["bytes32", "uint256", "address", "uint64", "bytes32", "bytes32"] as const;
export const STANDING_LEAF = ["bytes32", "uint256", "address", "uint256", "address", "int256", "uint256", "int256", "bool", "uint64", "uint256"] as const;
export const PAYOUT_LEAF = ["bytes32", "uint256", "address", "uint256", "address", "uint256"] as const;

type Types = readonly string[];

export function leafHash(types: Types, values: readonly unknown[]): Hex {
  const enc = encodeAbiParameters(types.map((type) => ({ type })), values as never);
  return keccak256(keccak256(enc));
}

const lt = (a: Hex, b: Hex) => BigInt(a) < BigInt(b);
export const hashPair = (a: Hex, b: Hex): Hex => keccak256(lt(a, b) ? concat([a, b]) : concat([b, a]));

export class MerkleTree {
  readonly tree: Hex[];
  /** Tree index of each leaf, by the leaf's position in the input. */
  private readonly at: number[];

  constructor(readonly leaves: Hex[]) {
    if (leaves.length === 0) throw new Error("empty tree");
    const order = leaves.map((h, i) => ({ h, i })).sort((x, y) => (lt(x.h, y.h) ? -1 : lt(y.h, x.h) ? 1 : 0));
    const n = leaves.length;
    this.tree = new Array<Hex>(2 * n - 1);
    this.at = new Array<number>(n);
    order.forEach((x, k) => {
      const j = this.tree.length - 1 - k;
      this.tree[j] = x.h;
      this.at[x.i] = j;
    });
    for (let j = this.tree.length - 1 - n; j >= 0; j--) this.tree[j] = hashPair(this.tree[2 * j + 1]!, this.tree[2 * j + 2]!);
  }

  get root(): Hex {
    return this.tree[0]!;
  }

  proof(leafIndex: number): Hex[] {
    let j = this.at[leafIndex];
    if (j === undefined) throw new Error("no such leaf");
    const p: Hex[] = [];
    while (j > 0) {
      p.push(this.tree[j % 2 === 1 ? j + 1 : j - 1]!);
      j = Math.floor((j - 1) / 2);
    }
    return p;
  }
}

/** OpenZeppelin MerkleProof.processProof. */
export const processProof = (proof: Hex[], leaf: Hex): Hex => proof.reduce((h, p) => hashPair(h, p), leaf);
