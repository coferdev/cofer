import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ContractFunctionRevertedError, encodeErrorResult, HttpRequestError } from "viem";
import { coferPotAbi } from "../src/chain/abi";
import { failureReason, RevertedOnChain, voteAlertClears, voteAlertKey, voteFailedText } from "../src/relayer/voteAlerts";
import { isFinalFailure } from "../src/queues";
import { clearVoteAlerts } from "../src/keeper/keeper";
import type { AlertDeps } from "../src/keeper/alerts";

const ID = "0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const POT = "0x00000000000000000000000000000000000c0FFE";
const P = { id: ID, pot: POT, summary: "Buy TSLA with 100 USDG" };
const revert = (errorName: "SlippageTooLoose" | "InsufficientBalance") =>
  new ContractFunctionRevertedError({ abi: coferPotAbi, functionName: "execute", data: encodeErrorResult({ abi: coferPotAbi, errorName } as never) });

describe("vote failure alert texts", () => {
  test("a permanent revert", () => {
    expect(voteFailedText(P, "SlippageTooLoose", { permanent: true })).toBe(
      "Vote 0xabcdef01… in pot 0x00000000… (Buy TSLA with 100 USDG) failed to execute: SlippageTooLoose. It is marked failed and will not run.",
    );
  });

  test("still failing after the last retry", () => {
    expect(voteFailedText(P, "InsufficientBalance", { tries: 5 })).toBe("Vote 0xabcdef01… in pot 0x00000000… (Buy TSLA with 100 USDG) is still failing to execute after 5 tries: InsufficientBalance.");
  });

  test("the reason is the contract's error name or a fixed phrase, never raw error text", () => {
    expect(failureReason(revert("InsufficientBalance"))).toBe("InsufficientBalance");
    expect(failureReason(new RevertedOnChain("0x1234"))).toBe("the transaction reverted on-chain");
    const rpc = failureReason(new HttpRequestError({ url: "https://rpc.example/SECRETKEY123", details: "fetch failed" }));
    expect(rpc).toStartWith("chain error");
    expect(rpc).not.toMatch(/https?:|SECRET|fetch failed/);
  });
});

describe("when a vote alert clears", () => {
  const NOW = 1_800_000_000;
  test("executed, expired, stale or gone: clears, saying why", () => {
    expect(voteAlertClears({ status: "executed", deadline: NOW + 1 }, NOW)).toBe("it executed");
    expect(voteAlertClears({ status: "expired", deadline: NOW - 1 }, NOW)).toBe("it expired");
    expect(voteAlertClears({ status: "stale", deadline: NOW + 1 }, NOW)).toBe("group settings changed, so it can no longer run");
    expect(voteAlertClears(undefined, NOW)).toBe("the vote is gone");
  });

  test("still meant to run (ready, queued): stays open", () => {
    expect(voteAlertClears({ status: "ready", deadline: NOW + 1 }, NOW)).toBeNull();
    expect(voteAlertClears({ status: "queued", deadline: NOW + 1 }, NOW)).toBeNull();
  });

  test("marked failed: stays open until its deadline passes", () => {
    expect(voteAlertClears({ status: "failed", deadline: NOW + 60 }, NOW)).toBeNull();
    expect(voteAlertClears({ status: "failed", deadline: NOW - 60 }, NOW)).toBe("its deadline has passed");
  });

  test("the keeper's ops job sends one 'Cleared (why)' per ended vote and leaves the rest open", async () => {
    const rows: Record<string, { status: string; deadline: number }> = {
      "0xa1": { status: "executed", deadline: NOW + 1 },
      "0xa2": { status: "queued", deadline: NOW + 1 },
      "0xa3": { status: "failed", deadline: NOW - 1 },
    };
    const open = new Map(Object.keys(rows).map((id) => [voteAlertKey(id), `vote ${id} failed`]));
    const sent: string[] = [];
    const alerts: AlertDeps = {
      async open(k, t) {
        if (open.has(k)) return false;
        open.set(k, t);
        return true;
      },
      async close(k) {
        const t = open.get(k) ?? null;
        open.delete(k);
        return t;
      },
      async send(t) {
        sent.push(t);
      },
    };
    const n = await clearVoteAlerts({ open: async () => [...open.keys()], proposal: async (id) => rows[id], alerts, now: () => NOW });
    expect(n).toBe(2);
    expect(sent).toEqual(["Cleared (it executed): vote 0xa1 failed", "Cleared (its deadline has passed): vote 0xa3 failed"]);
    expect([...open.keys()]).toEqual([voteAlertKey("0xa2")]);
  });
});

describe("the last retry", () => {
  test("BullMQ counts the attempt before 'failed' fires: final when attempts made reach attempts allowed", () => {
    expect(isFinalFailure({ attemptsMade: 4, opts: { attempts: 5 } })).toBe(false);
    expect(isFinalFailure({ attemptsMade: 5, opts: { attempts: 5 } })).toBe(true);
    expect(isFinalFailure({ attemptsMade: 1, opts: {} })).toBe(true); // no retries configured
    const unrecoverable = Object.assign(new Error("x"), { name: "UnrecoverableError" });
    expect(isFinalFailure({ attemptsMade: 1, opts: { attempts: 5 } }, unrecoverable)).toBe(true);
  });
});

describe("wiring", () => {
  const relayer = readFileSync(join(import.meta.dir, "..", "src", "relayer", "relayer.ts"), "utf8");
  const keeper = readFileSync(join(import.meta.dir, "..", "src", "keeper", "keeper.ts"), "utf8");

  test("a permanent revert alerts only when the vote is marked failed (not stale or expired)", () => {
    expect(relayer).toContain('if (status === "failed") await checkAlert(voteAlertKey(proposalId), voteFailedText(row, name, { permanent: true }));');
  });

  test("a retryable failure records its reason, and the last one alerts", () => {
    expect(relayer).toContain(".set({ error: failureReason(e) })");
    expect(relayer).toMatch(/w\.on\("failed", \(job, err\) => \{\s*if \(job && isFinalFailure\(job, err\)\) void alertStillFailing\(/);
    expect(relayer).toContain('if (!row || !["ready", "queued"].includes(row.status)) return;');
  });

  test("the keeper's ops job runs every 5 minutes and clears vote alerts", () => {
    expect(keeper).toContain('await q.upsertJobScheduler("ops", { every: 300_000 }, { name: "ops" });');
    expect(keeper).toContain("voteAlertsCleared: clearVoteAlerts,");
  });
});
