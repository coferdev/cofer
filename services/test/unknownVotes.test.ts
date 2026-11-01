import { describe, expect, test } from "bun:test";
import type { Address, Hex } from "viem";
import { groupText, kindText, onVoteEvent, opsText, utcText, type UnknownVoteDeps, type VoteEvent } from "../src/indexer/unknownVotes";
import { Kind } from "../src/core/proposal";

const POT = "0x00000000000000000000000000000000000000aa" as Address;
const DIGEST = `0x${"ab".repeat(32)}` as Hex;
const ETA = 1_793_628_300n; // 2 Nov 2026 14:05 UTC
const CHAT = -1001;

function fakeDeps(chat: number | null = CHAT) {
  const group: [number, string][] = [];
  const ops: string[] = [];
  const deps: UnknownVoteDeps = {
    chatOf: async () => chat,
    sendGroup: async (c, t) => void group.push([c, t]),
    sendOps: async (t) => void ops.push(t),
  };
  return { deps, group, ops };
}

const queued: VoteEvent = { name: "ProposalQueued", digest: DIGEST, kind: Kind.TRANSFER, eta: ETA };
const executed: VoteEvent = { name: "ProposalExecuted", digest: DIGEST, kind: Kind.SWAP };

describe("votes not made through the bot (M-3)", () => {
  test("an unknown queued vote tells the group when it can run and how to exit, and alerts ops", async () => {
    const f = fakeDeps();
    expect(await onVoteEvent(f.deps, { pot: POT, event: queued, isNew: true, known: false })).toBe("alerted");
    expect(f.group).toHaveLength(1);
    const [chat, text] = f.group[0]!;
    expect(chat).toBe(CHAT);
    expect(text).toBe("A vote that was not made through this bot was queued: send funds. It can run after 14:05 UTC on 2 Nov 2026. If you disagree, use /exit before then to take your exact share.");
    expect(f.ops).toHaveLength(1);
    expect(f.ops[0]).toContain(POT);
    expect(f.ops[0]).toContain(DIGEST);
  });

  test("an unknown executed vote (e.g. a unanimous swap, which runs at once) is reported too", async () => {
    const f = fakeDeps();
    expect(await onVoteEvent(f.deps, { pot: POT, event: executed, isNew: true, known: false })).toBe("alerted");
    expect(f.group[0]![1]).toBe("A vote that was not made through this bot just executed: swap. Check /pot.");
    expect(f.ops[0]).toContain("executed");
  });

  test("a vote the bot made sends nothing extra (the notifier card covers it)", async () => {
    const f = fakeDeps();
    expect(await onVoteEvent(f.deps, { pot: POT, event: queued, isNew: true, known: true })).toBe("skipped");
    expect(f.group).toHaveLength(0);
    expect(f.ops).toHaveLength(0);
  });

  test("an event already recorded (indexer re-run) is not sent twice", async () => {
    const f = fakeDeps();
    expect(await onVoteEvent(f.deps, { pot: POT, event: queued, isNew: false, known: false })).toBe("skipped");
    expect(f.group).toHaveLength(0);
    expect(f.ops).toHaveLength(0);
  });

  test("a pot with no group on record still alerts ops", async () => {
    const f = fakeDeps(null);
    expect(await onVoteEvent(f.deps, { pot: POT, event: queued, isNew: true, known: false })).toBe("alerted");
    expect(f.group).toHaveLength(0);
    expect(f.ops).toHaveLength(1);
  });

  test("a failed send is passed up, so the indexer can handle the log again", async () => {
    const f = fakeDeps();
    f.deps.sendOps = async () => {
      throw new Error("ops chat down");
    };
    await expect(onVoteEvent(f.deps, { pot: POT, event: queued, isNew: true, known: false })).rejects.toThrow("ops chat down");
  });

  test("text helpers", () => {
    expect(utcText(ETA)).toBe("14:05 UTC on 2 Nov 2026");
    expect(kindText(Kind.SET_CONFIG)).toBe("change the group settings");
    expect(kindText(99)).toBe("vote type 99");
    expect(groupText(queued)).toContain("/exit");
    expect(opsText(POT, queued)).toContain("can run after 14:05 UTC on 2 Nov 2026");
  });

  test("the indexer wires both events to the alert, and records each log only once", async () => {
    const src = await Bun.file(new URL("../src/indexer/indexer.ts", import.meta.url)).text();
    expect(src.match(/alertIfUnknown\(log, pot, event, isNew, hit\.length > 0\)/g)).toHaveLength(2);
    expect(src).toContain(".onConflictDoNothing()\n    .returning(");
  });
});
