import { describe, expect, test } from "bun:test";
import recorded from "./fixtures/tx-receipts-46630.json";
import { depositReceipt } from "../src/core/receipts";
import { EXIT_POT, EXITER, fakeReceipts, getJson, publicServer, recordedReceipt, T_USDG } from "./publicApiHarness";

describe("GET /v1/receipts/deposit/:tx", () => {
  test("a recorded testnet deposit: amount, shares minted, the group's total before", async () => {
    const r = await getJson(publicServer(), `/v1/receipts/deposit/${recorded.kinds.Deposited}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ kind: "deposit", chainId: 46630, pot: EXIT_POT, member: EXITER, amount: "100000000", sharesMinted: "100000000000000000000", groupTotalBefore: "0", usdg: T_USDG });
  });

  test("the share maths re-checked from the log: a first deposit into an empty group", async () => {
    const d = (await depositReceipt(recordedReceipt(recorded.kinds.Deposited), fakeReceipts()))!;
    // shares = amount x (totalShares + 10^12) / (total before + 1); empty group: totalShares 0, total 0
    expect(d.sharesMinted).toBe((d.amount * (0n + 10n ** 12n)) / (d.groupTotalBefore + 1n));
  });

  test("the checks read the right blocks", async () => {
    const d = (await depositReceipt(recordedReceipt(recorded.kinds.Deposited), fakeReceipts()))!;
    const before = d.block - 1n;
    expect(d.checks.map((c) => c.command)).toContain(`cast call ${EXIT_POT} "totalShares()(uint256)" --block ${before} --rpc-url https://rpc.testnet.chain.robinhood.com`);
    expect(d.checks.map((c) => c.command)).toContain(`cast call ${T_USDG} "balanceOf(address)(uint256)" ${EXIT_POT} --block ${d.block} --rpc-url https://rpc.testnet.chain.robinhood.com`);
  });

  test("an exit is not a deposit", async () => {
    expect((await getJson(publicServer(), `/v1/receipts/deposit/${recorded.kinds.Exited}`)).body.error.message).toBe("This transaction has no Cofer deposit.");
  });
});
