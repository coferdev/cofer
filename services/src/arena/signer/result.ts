/**
 * The Result a table's signers sign (spec §3.6): an EIP-712 digest with the domain "Cofer Arena" / "1" / chain id /
 * the ResultRegistry, exactly as ResultRegistry.resultDigest builds it on-chain.
 */
import { type Hex, encodePacked, hashTypedData, keccak256, toBytes } from "viem";

export interface ArenaResult {
  round: number;
  logHead: Hex;
  eventsRoot: Hex;
  standingsRoot: Hex;
  podium: Hex[];
  payoutRoot: Hex;
  totalPayout: bigint;
  engineBuild: Hex;
  logURI: string;
}

const TYPES = {
  Result: [
    { name: "table", type: "address" },
    { name: "round", type: "uint8" },
    { name: "rulesHash", type: "bytes32" },
    { name: "logHead", type: "bytes32" },
    { name: "eventsRoot", type: "bytes32" },
    { name: "standingsRoot", type: "bytes32" },
    { name: "podiumHash", type: "bytes32" },
    { name: "payoutRoot", type: "bytes32" },
    { name: "totalPayout", type: "uint256" },
    { name: "engineBuild", type: "bytes32" },
    { name: "logURIHash", type: "bytes32" },
  ],
} as const;

export function resultDigest(chainId: number, registry: Hex, table: Hex, rulesHash: Hex, r: ArenaResult): Hex {
  return hashTypedData({
    domain: { name: "Cofer Arena", version: "1", chainId, verifyingContract: registry },
    types: TYPES,
    primaryType: "Result",
    message: {
      table,
      round: r.round,
      rulesHash,
      logHead: r.logHead,
      eventsRoot: r.eventsRoot,
      standingsRoot: r.standingsRoot,
      // abi.encodePacked(address[]) pads each element to 32 bytes, as viem does for packed arrays
      podiumHash: keccak256(encodePacked(["address[]"], [r.podium])),
      payoutRoot: r.payoutRoot,
      totalPayout: r.totalPayout,
      engineBuild: r.engineBuild,
      logURIHash: keccak256(toBytes(r.logURI)),
    },
  });
}
