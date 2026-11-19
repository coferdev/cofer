/** Receipts as the public API serves them pass the SDK's checker against the same recorded chain data. */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import recorded from "./fixtures/tx-receipts-46630.json";
import { verifyReceipt, type ChainReader } from "../../sdk/src";
import { main } from "../../sdk/bin/cofer";
import { getJson, publicServer } from "./publicApiHarness";

const chain: ChainReader = {
  getTransactionReceipt: async ({ hash }) => {
    const r = recorded.receipts.find((x) => x.transactionHash === hash)!;
    return { blockNumber: BigInt(r.blockNumber), status: r.status as "success", logs: r.logs as never };
  },
  readContract: async () => "0x",
  verifyTypedData: async () => true,
};

describe("API receipts and the SDK checker", () => {
  for (const [kind, hash] of [["exit", recorded.kinds.Exited], ["deposit", recorded.kinds.Deposited], ["spend", recorded.kinds.AllowanceSpent]] as const) {
    test(`a ${kind} receipt from the API matches the chain`, async () => {
      const r = await getJson(publicServer(), `/v1/receipts/${kind}/${hash}`);
      const v = await verifyReceipt(r.body, chain);
      expect(v.failed).toEqual([]);
      expect(v.ok).toBe(true);
    });
  }

  test("the command line says so, and fails on a changed receipt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cofer-verify-"));
    const body = (await getJson(publicServer(), `/v1/receipts/exit/${recorded.kinds.Exited}`)).body;
    writeFileSync(join(dir, "ok.json"), JSON.stringify(body));
    writeFileSync(join(dir, "bad.json"), JSON.stringify({ ...body, data: { ...body.data, sharesBurned: "1" } }));
    const lines: string[] = [];
    expect(await main(["verify", join(dir, "ok.json")], (s) => lines.push(s), chain)).toBe(0);
    expect(await main(["verify", join(dir, "bad.json")], (s) => lines.push(s), chain)).toBe(1);
    expect(lines[0]).toMatch(/^Receipt matches the chain \(\d+ lines checked\)\.$/);
    expect(lines[1]).toContain("- shares burned: receipt says 1, the chain says 100000000000000000000");
    expect(await main(["verify"], (s) => lines.push(s), chain)).toBe(2);
  });
});
