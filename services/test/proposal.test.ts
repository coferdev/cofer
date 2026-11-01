import { describe, expect, test } from "bun:test";
import { encodeAbiParameters, keccak256, concat, toHex, getAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress } from "viem";
import {
  Kind,
  decodeAction,
  describe as describeAction,
  encodeAction,
  proposalDigest,
  randomNonce,
  typedData,
  type Action,
} from "../src/core/proposal";
import { potEvm, POT } from "./evm";

const USDG = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
const TSLA = getAddress("0x00000000000000000000000000000000000075a1");
const ALICE = getAddress("0x00000000000000000000000000000000000a11ce");
const ADAPTER = getAddress("0x00000000000000000000000000000000000adab7");

const samples: Action[] = [
  { kind: Kind.TRANSFER, asset: USDG, to: ALICE, amount: 100_000_000n },
  { kind: Kind.SWAP, adapter: ADAPTER, tokenIn: USDG, tokenOut: TSLA, amountIn: 250_000_000n, minOut: 990_000_000_000_000_000n, route: concat([USDG, "0x000bb8", TSLA]).toLowerCase() as `0x${string}` },
  { kind: Kind.ADD_MEMBER, member: ALICE },
  { kind: Kind.REMOVE_MEMBER, member: ALICE },
  { kind: Kind.SET_ALLOWANCE, member: ALICE, amount: 50_000_000n, period: 604800 },
  { kind: Kind.SET_THRESHOLD, threshold: 0, thresholdBps: 6000 },
  { kind: Kind.SET_CONFIG, guardDelay: 21600, maxSlipBps: 300, entrySpreadBps: 50, depositsOpen: true },
  { kind: Kind.PAY_PLAN, months: 3, maxCost: 27_000_000n },
];

/** Independent re-implementation of CoferPot.hashProposal (abi.encode + keccak), no typed-data lib. */
function solidityStyleDigest(pot: Address, chainId: number, kind: number, data: `0x${string}`, nonce: bigint, epoch: bigint, deadline: bigint) {
  const DOMAIN_TYPEHASH = keccak256(toHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
  const PROPOSAL_TYPEHASH = keccak256(toHex("Proposal(uint8 kind,bytes data,uint256 nonce,uint64 epoch,uint64 deadline)"));
  const domain = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [DOMAIN_TYPEHASH, keccak256(toHex("Cofer")), keccak256(toHex("1")), BigInt(chainId), pot],
    ),
  );
  const struct = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint8" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint64" }, { type: "uint64" }],
      [PROPOSAL_TYPEHASH, kind, keccak256(data), nonce, epoch, deadline],
    ),
  );
  return keccak256(concat(["0x1901", domain, struct]));
}

describe("proposal encoding", () => {
  test("encode/decode round-trips every kind", () => {
    for (const a of samples) {
      const { kind, data } = encodeAction(a);
      expect(decodeAction(kind, data)).toEqual(a);
    }
  });

  test("rejects out-of-range params before anyone signs", () => {
    expect(() => encodeAction({ kind: Kind.SET_CONFIG, guardDelay: 4 * 86400, maxSlipBps: 300, entrySpreadBps: 0, depositsOpen: true })).toThrow();
    expect(() => encodeAction({ kind: Kind.SET_ALLOWANCE, member: ALICE, amount: 1n, period: 60 })).toThrow();
    expect(() => encodeAction({ kind: Kind.PAY_PLAN, months: 13, maxCost: 1n })).toThrow();
    expect(() => encodeAction({ kind: Kind.PAY_PLAN, months: 3, maxCost: -1n })).toThrow();
    expect(() => encodeAction({ kind: Kind.TRANSFER, asset: USDG, to: ALICE, amount: 0n })).toThrow();
  });

  test("random nonces are 256-bit and distinct", () => {
    const a = randomNonce();
    const b = randomNonce();
    expect(a).not.toBe(b);
    expect(a < 2n ** 256n).toBe(true);
  });

  test("human summary is rendered from calldata", () => {
    const meta = (t: Address) => (t === USDG ? { symbol: "USDG", decimals: 6 } : { symbol: "TSLA", decimals: 18 });
    const name = (a: Address) => (a === ALICE ? "@alice" : a);
    expect(describeAction(samples[0]!, meta, name)).toBe("Send 100 USDG to @alice");
    expect(describeAction(samples[1]!, meta, name)).toBe("Swap 250 USDG for at least 0.99 TSLA");
    expect(describeAction(samples[4]!, meta, name)).toBe("Give @alice an allowance of 50 USDG every week");
    expect(describeAction(samples[7]!, meta, name)).toBe("Prepay the group plan for 3 months (at most 27 USDG)");
  });

  test("a plan vote carries its maximum cost in the signed bytes (audit L-1)", () => {
    const { data } = encodeAction({ kind: Kind.PAY_PLAN, months: 3, maxCost: 27_000_000n });
    expect(data).toBe(encodeAbiParameters([{ type: "uint8" }, { type: "uint256" }], [3, 27_000_000n]));
  });

  test("/plan reads today's price and puts months x price in the vote as its maximum", async () => {
    const src = await Bun.file(new URL("../src/bot/bot.ts", import.meta.url)).text();
    const cmd = src.slice(src.indexOf('bot.command("plan"'), src.indexOf('bot.command("pot"'));
    expect(cmd).toContain('functionName: "planPricePerMonth"');
    expect(cmd).toContain("* BigInt(months)");
    expect(cmd.indexOf("planPricePerMonth")).toBeLessThan(cmd.indexOf("propose(ctx, { kind: Kind.PAY_PLAN, months, maxCost })"));
  });
});

describe("EIP-712 parity with CoferPot.sol", () => {
  test("viem typed-data digest == Solidity-style abi.encode digest", () => {
    for (const a of samples) {
      const { kind, data } = encodeAction(a);
      const nonce = randomNonce();
      const env = { pot: POT, chainId: 4663, kind, data, nonce, epoch: 3n, deadline: 1_900_000_000n } as const;
      expect(proposalDigest(env)).toBe(solidityStyleDigest(POT, 4663, kind, data, nonce, 3n, 1_900_000_000n));
    }
  });

  test("viem digest == compiled CoferPot.hashProposal() executed in an EVM", async () => {
    const evm = await potEvm(4663);
    for (const a of samples) {
      const { kind, data } = encodeAction(a);
      const nonce = randomNonce();
      const env = { pot: POT, chainId: 4663, kind, data, nonce, epoch: 7n, deadline: 2_000_000_000n } as const;
      const onchain = await evm.call("hashProposal", [kind, data, nonce, 7n, 2_000_000_000n]);
      expect(onchain).toBe(proposalDigest(env));
    }
  });

  test("domain separator binds chainId and pot address", async () => {
    const evm = await potEvm(4663);
    const sep = await evm.call("domainSeparator");
    const other = await (await potEvm(46630)).call("domainSeparator");
    expect(sep).not.toBe(other);
  });

  test("fixture shared with contracts/test/Parity.t.sol", () => {
    const { data } = encodeAction({ kind: Kind.TRANSFER, asset: USDG, to: "0x000000000000000000000000000000000000f00d", amount: 100_000_000n });
    const d = proposalDigest({ pot: POT, chainId: 4663, kind: Kind.TRANSFER, data, nonce: 42n, epoch: 0n, deadline: 4_000_000_000n });
    expect(d).toBe("0xa3e41da42fd01dedbc3e4b7600ae28231e31f47e4360226fb7aebbff916cde7a");
  });

  test("a member's EOA signature over the typed data recovers to the member", async () => {
    const acct = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000a11ce1");
    const { kind, data } = encodeAction(samples[0]!);
    const td = typedData({ pot: POT, chainId: 4663, kind, data, nonce: 1n, epoch: 0n, deadline: 2_000_000_000n });
    const sig = await acct.signTypedData(td);
    expect(await recoverTypedDataAddress({ ...td, signature: sig })).toBe(acct.address);
    // the same signature does not authorize a different nonce (replay protection)
    const td2 = typedData({ pot: POT, chainId: 4663, kind, data, nonce: 2n, epoch: 0n, deadline: 2_000_000_000n });
    expect(await recoverTypedDataAddress({ ...td2, signature: sig })).not.toBe(acct.address);
  });
});
