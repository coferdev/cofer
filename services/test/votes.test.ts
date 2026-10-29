import { describe, expect, test } from "bun:test";
import { getAddress, type Address } from "viem";
import { Kind } from "../src/core/proposal";
import { packVotes, requiredVotes, sortVotes, tally, type PotRules } from "../src/core/votes";

const a = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`) as Address;
const sig = "0x01" as const;

describe("requiredVotes mirrors CoferPot.requiredVotes", () => {
  test("60% rounds up: 1->1, 2->2, 3->2, 4->3, 5->3, 10->6", () => {
    const want: Record<number, number> = { 1: 1, 2: 2, 3: 2, 4: 3, 5: 3, 10: 6 };
    for (const [n, r] of Object.entries(want)) {
      const members = Array.from({ length: Number(n) }, (_, i) => a(i + 1));
      expect(requiredVotes({ members, threshold: 0, thresholdBps: 6000 })).toBe(r);
    }
  });

  test("fixed threshold is clamped to member count", () => {
    expect(requiredVotes({ members: [a(1), a(2)], threshold: 3, thresholdBps: 0 })).toBe(2);
  });
});

describe("tally", () => {
  const rules: PotRules = { members: [a(5), a(1), a(3), a(4), a(2)], threshold: 0, thresholdBps: 6000, guardDelay: 21600 };

  test("sorts ascending and dedupes (contract rejects unsorted/duplicate signers)", () => {
    const s = sortVotes([{ signer: a(3), signature: sig }, { signer: a(1), signature: sig }, { signer: a(3), signature: sig }]);
    expect(s.map((v) => v.signer)).toEqual([a(1), a(3)]);
  });

  test("3 of 5 passes but waits the exit window; unanimous skips it", () => {
    const t3 = tally(rules, Kind.TRANSFER, [1, 2, 3].map((i) => ({ signer: a(i), signature: sig })));
    expect(t3.ready).toBe(true);
    expect(t3.delaySeconds).toBe(21600);
    const t5 = tally(rules, Kind.TRANSFER, [1, 2, 3, 4, 5].map((i) => ({ signer: a(i), signature: sig })));
    expect(t5.unanimous).toBe(true);
    expect(t5.delaySeconds).toBe(0);
  });

  test("swaps never wait (assets stay in the pot, oracle floor applies)", () => {
    expect(tally(rules, Kind.SWAP, [1, 2, 3].map((i) => ({ signer: a(i), signature: sig }))).delaySeconds).toBe(0);
  });

  test("non-members and revoked votes do not count", () => {
    const t = tally(rules, Kind.TRANSFER, [1, 2, 9].map((i) => ({ signer: a(i), signature: sig })), new Set([a(2).toLowerCase()]));
    expect(t.approvals).toBe(1);
    expect(t.ready).toBe(false);
    expect(t.ignored.map((x) => x.reason).sort()).toEqual(["not_member", "revoked"]);
  });

  test("packVotes keeps only counted signers, sorted", () => {
    const votes = [3, 9, 1].map((i) => ({ signer: a(i), signature: sig }));
    const t = tally(rules, Kind.TRANSFER, votes);
    expect(packVotes(votes, t.counted).map((v) => v.signer)).toEqual([a(1), a(3)]);
  });
});
