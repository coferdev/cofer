import { describe, expect, test } from "bun:test";
import { ContractFunctionRevertedError, encodeAbiParameters, encodeErrorResult, encodeEventTopics, type Hex } from "viem";
import { potAbi } from "../src/chain/clients";
import { alertStillFailing, relayOnce, revertName, type RelayDeps } from "../src/relayer/relayer";
import { RevertedOnChain, voteAlertKey } from "../src/relayer/voteAlerts";

const ID = `0x${"ab".repeat(32)}` as Hex;
const POT = "0x00000000000000000000000000000000000000a1";
const HASH = `0x${"12".repeat(32)}` as Hex;
const NOW = 1_800_000_000;

type Row = { id: string; pot: string; summary: string; status: string; queuedEta?: number | null; error?: string | null };

function revert(errorName: string, args: readonly unknown[] = []) {
  const data = encodeErrorResult({ abi: potAbi, errorName, args } as never);
  return new ContractFunctionRevertedError({ abi: potAbi, data, functionName: "execute" });
}
function queuedLog(eta: number) {
  return {
    address: POT,
    topics: encodeEventTopics({ abi: potAbi, eventName: "ProposalQueued", args: { digest: ID } }),
    data: encodeAbiParameters([{ type: "uint8" }, { type: "uint256" }, { type: "uint64" }], [1, 7n, BigInt(eta)]),
  };
}
function executedLog(address = POT) {
  return {
    address,
    topics: encodeEventTopics({ abi: potAbi, eventName: "ProposalExecuted", args: { digest: ID } }),
    data: encodeAbiParameters([{ type: "uint8" }, { type: "uint256" }, { type: "uint256" }], [1, 7n, 2n]),
  };
}

/** Stand-ins for everything relayOnce talks to, recording what it did. */
function rig(row: Row | undefined, chain: { simulate?: () => unknown; status?: string; logs?: unknown[]; write?: () => unknown } = {}) {
  const log = { updates: [] as Record<string, unknown>[], relays: [] as [string, number | undefined][], notifies: [] as string[], alerts: [] as [string, unknown][], sent: 0 };
  const fakeDb = {
    query: { proposals: { findFirst: async () => row } },
    update: () => ({ set: (v: Record<string, unknown>) => ({ where: async () => void log.updates.push(v) }) }),
  };
  const pub = {
    simulateContract: async (req: unknown) => { if (chain.simulate) chain.simulate(); return { request: req }; },
    waitForTransactionReceipt: async () => ({ status: chain.status ?? "success", logs: chain.logs ?? [] }),
  };
  const wallet = { account: { address: "0x000000000000000000000000000000000000BEEF" }, writeContract: async () => { if (chain.write) chain.write(); log.sent++; return HASH; } };
  const d: RelayDeps = {
    db: (() => fakeDb) as never,
    publicClient: (() => pub) as never,
    relayerClient: (() => wallet) as never,
    buildExecuteArgs: (async () => ({ pot: POT, args: [] })) as never,
    enqueueRelay: (async (id: string, at?: number) => void log.relays.push([id, at])) as never,
    enqueueNotify: (async (id: string) => void log.notifies.push(id)) as never,
    checkAlert: (async (key: string, msg: unknown) => void log.alerts.push([key, msg])) as never,
    chainId: () => 46630,
    nowSec: () => NOW,
  };
  return { d, log };
}
const ready: Row = { id: ID, pot: POT, summary: "Send 50 USDG to @bob", status: "ready" };

describe("relayOnce", () => {
  test("skips a vote that is gone or not ready, without sending anything", async () => {
    for (const row of [undefined, { ...ready, status: "collecting" }, { ...ready, status: "executed" }, { ...ready, status: "failed" }]) {
      const { d, log } = rig(row);
      expect(await relayOnce(ID, d)).toBe("skipped");
      expect(log.sent + log.updates.length + log.relays.length + log.notifies.length).toBe(0);
    }
  });

  test("a queued vote whose wait has not ended is put back for eta + 2 s, nothing sent", async () => {
    const { d, log } = rig({ ...ready, status: "queued", queuedEta: NOW + 600 });
    expect(await relayOnce(ID, d)).toBe("skipped");
    expect(log.relays).toEqual([[ID, NOW + 602]]);
    expect(log.sent).toBe(0);
  });

  test("a queued vote whose wait has ended is sent", async () => {
    const { d, log } = rig({ ...ready, status: "queued", queuedEta: NOW - 1 }, { logs: [executedLog()] });
    expect(await relayOnce(ID, d)).toBe("executed");
    expect(log.sent).toBe(1);
  });

  test("executed: status and tx hash saved, members told", async () => {
    const { d, log } = rig(ready, { logs: [executedLog()] });
    expect(await relayOnce(ID, d)).toBe("executed");
    expect(log.updates).toEqual([{ status: "executed", txHash: HASH }]);
    expect(log.notifies).toEqual([ID]);
  });

  test("queued by the contract: eta saved, retried at eta + 2 s, members told", async () => {
    const eta = NOW + 3600;
    const { d, log } = rig(ready, { logs: [queuedLog(eta)] });
    expect(await relayOnce(ID, d)).toBe("queued");
    expect(log.updates).toEqual([{ status: "queued", queuedEta: eta, txHash: HASH }]);
    expect(log.relays).toEqual([[ID, eta + 2]]);
    expect(log.notifies).toEqual([ID]);
  });

  test("logs from other contracts and unknown events are ignored", async () => {
    const other = executedLog("0x00000000000000000000000000000000000000b2");
    const junk = { address: POT, topics: [`0x${"00".repeat(32)}`], data: "0x" };
    const { d, log } = rig(ready, { logs: [other, junk] });
    expect(await relayOnce(ID, d)).toBe("skipped");
    expect(log.updates).toEqual([]);
  });

  test("mined but reverted: the reason is kept and the error is thrown for a retry", async () => {
    const { d, log } = rig(ready, { status: "reverted" });
    await expect(relayOnce(ID, d)).rejects.toBeInstanceOf(RevertedOnChain);
    expect(log.updates).toEqual([{ error: "the transaction reverted on-chain" }]);
    expect(log.alerts).toEqual([]);
  });

  test("StaleEpoch and Expired end the vote without an alert (normal outcomes)", async () => {
    for (const [name, status] of [["StaleEpoch", "stale"], ["Expired", "expired"]] as const) {
      const { d, log } = rig(ready, { simulate: () => { throw revert(name); } });
      expect(await relayOnce(ID, d)).toBe("skipped");
      expect(log.updates).toEqual([{ status, error: name }]);
      expect(log.notifies).toEqual([ID]);
      expect(log.alerts).toEqual([]);
      expect(log.sent).toBe(0);
    }
  });

  test("other permanent refusals mark the vote failed and alert the staff once", async () => {
    const cases: [string, unknown[]][] = [["NonceUsed", []], ["UnknownKind", []], ["AssetNotBuyable", [POT]], ["AdapterNotAllowed", [POT]], ["SlippageTooLoose", [1n, 2n]]];
    for (const [name, args] of cases) {
      const { d, log } = rig(ready, { simulate: () => { throw revert(name, args); } });
      expect(await relayOnce(ID, d)).toBe("skipped");
      expect(log.updates).toEqual([{ status: "failed", error: name }]);
      expect(log.alerts.length).toBe(1);
      expect(log.alerts[0]![0]).toBe(voteAlertKey(ID));
      expect(JSON.stringify(log.alerts[0]![1])).toContain(`failed to execute: ${name}. It is marked failed and will not run.`);
    }
  });

  test("passing refusals (TooEarly, InsufficientBalance) keep the vote open and throw for a retry", async () => {
    for (const [name, args] of [["TooEarly", [BigInt(NOW + 10)]], ["InsufficientBalance", []]] as [string, unknown[]][]) {
      const { d, log } = rig(ready, { simulate: () => { throw revert(name, args); } });
      await expect(relayOnce(ID, d)).rejects.toBeInstanceOf(ContractFunctionRevertedError);
      expect(log.updates).toEqual([{ error: name }]);
      expect(log.alerts).toEqual([]);
      expect(log.sent).toBe(0);
    }
  });

  test("a chain error while sending is kept as a fixed reason, never raw text, and retried", async () => {
    const { d, log } = rig(ready, { write: () => { throw new Error("connect ECONNREFUSED 10.0.0.1:8545 secret-url"); } });
    await expect(relayOnce(ID, d)).rejects.toThrow();
    expect(log.updates.length).toBe(1);
    expect(String(log.updates[0]!.error)).not.toContain("secret-url");
  });
});

describe("revertName", () => {
  test("finds the contract's error name, or nothing", () => {
    expect(revertName(revert("Expired"))).toBe("Expired");
    expect(revertName(new Error("plain"))).toBeUndefined();
    expect(revertName("text")).toBeUndefined();
  });
});

describe("alertStillFailing", () => {
  test("alerts with the try count for a vote still waiting, using its last reason", async () => {
    const { d, log } = rig({ ...ready, error: "TooEarly" });
    await alertStillFailing(ID, 8, d);
    expect(log.alerts.length).toBe(1);
    expect(JSON.stringify(log.alerts[0]![1])).toContain("still failing to execute after 8 tries: TooEarly.");
  });
  test("says nothing for a vote that has ended or is gone", async () => {
    for (const row of [undefined, { ...ready, status: "executed" }, { ...ready, status: "expired" }]) {
      const { d, log } = rig(row);
      await alertStillFailing(ID, 8, d);
      expect(log.alerts).toEqual([]);
    }
  });
  test("an unknown last reason is named as such", async () => {
    const { d, log } = rig({ ...ready, status: "queued" });
    await alertStillFailing(ID, 3, d);
    expect(JSON.stringify(log.alerts[0]![1])).toContain("unknown error");
  });
});
