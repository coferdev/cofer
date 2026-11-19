/**
 * The hash chain and the roots a result posts (spec §4.7):
 *   e_i = keccak256(encoded_i)
 *   h_0 = keccak256(abi.encode("COFER_ARENA_V1", chainId, table, rulesHash));  h_i = keccak256(h_{i−1} ‖ e_i)
 *   eventsRoot    over (EVENT_TAG, chainId, table, i, e_i, h_i)
 *   standingsRoot over (STANDING_TAG, chainId, table, rank, seat, finalEquity, maxDrawdownBps, score1e6, activityOk,
 *                       eliminatedAt, flags)
 *   payoutRoot    over (PAYOUT_TAG, chainId, table, index, account, amount)
 */
import { type Hex, concat, encodeAbiParameters, keccak256 } from "viem";
import type { Standing } from "../scoring/score";
import { EVENT_LEAF, EVENT_TAG, MerkleTree, PAYOUT_LEAF, PAYOUT_TAG, STANDING_LEAF, STANDING_TAG, leafHash } from "./merkle";

export function logGenesis(chainId: number, table: Hex, rulesHash: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "string" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }], ["COFER_ARENA_V1", BigInt(chainId), table, rulesHash]));
}

export const chainNext = (prev: Hex, e: Hex): Hex => keccak256(concat([prev, e]));

export class LogChain {
  head: Hex;
  readonly e: Hex[] = [];
  readonly h: Hex[] = [];

  constructor(readonly chainId: number, readonly table: Hex, rulesHash: Hex) {
    this.head = logGenesis(chainId, table, rulesHash);
  }

  /** Append one encoded event; returns its index i (0-based) and the new head. */
  append(encoded: Hex): { i: number; head: Hex } {
    const e = keccak256(encoded);
    this.head = chainNext(this.head, e);
    this.e.push(e);
    this.h.push(this.head);
    return { i: this.e.length - 1, head: this.head };
  }

  eventsTree(): MerkleTree {
    return new MerkleTree(this.e.map((e, i) => leafHash(EVENT_LEAF, [EVENT_TAG, BigInt(this.chainId), this.table, BigInt(i), e, this.h[i]!])));
  }
}

/** Recompute the head from encoded events (the replay's first check). */
export function headOf(chainId: number, table: Hex, rulesHash: Hex, encoded: Hex[]): Hex {
  let h = logGenesis(chainId, table, rulesHash);
  for (const x of encoded) h = chainNext(h, keccak256(x));
  return h;
}

export function standingsTree(chainId: number, table: Hex, rows: Standing[]): MerkleTree {
  return new MerkleTree(rows.map((r) => leafHash(STANDING_LEAF, [
    STANDING_TAG, BigInt(chainId), table, BigInt(r.rank), r.seat as Hex, r.finalEquity, r.maxDrawdownBps, r.score1e6,
    r.activityOk, BigInt(r.eliminatedAt ?? 0), BigInt(r.flags),
  ])));
}

export function payoutTree(chainId: number, table: Hex, rows: { index: number; account: Hex; amount: bigint }[]): MerkleTree {
  return new MerkleTree(rows.map((r) => leafHash(PAYOUT_LEAF, [PAYOUT_TAG, BigInt(chainId), table, BigInt(r.index), r.account, r.amount])));
}
