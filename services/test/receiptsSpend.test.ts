import { describe, expect, test } from "bun:test";
import recorded from "./fixtures/tx-receipts-46630.json";
import { spendReceipt } from "../src/core/receipts";
import { fakeReceipts, getJson, POT_MEMBERS, publicServer, recordedReceipt, T_USDG } from "./publicApiHarness";

describe("GET /v1/receipts/spend/:tx", () => {
  test("a recorded testnet allowance spend: spender, recipient, amount, memo, what is left", async () => {
    const r = await getJson(publicServer(), `/v1/receipts/spend/${recorded.kinds.AllowanceSpent}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ kind: "spend", pot: "0x867851A44059BC0dB4202E78ecdC97bF55d8776e", spender: POT_MEMBERS[1], to: POT_MEMBERS[0], amount: "2000000", allowanceLeft: "3000000", usdg: T_USDG });
    expect(r.body.data.memo).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test("the checks read the spender's allowance and the recipient's USDG before and after", async () => {
    const s = (await spendReceipt(recordedReceipt(recorded.kinds.AllowanceSpent), fakeReceipts()))!;
    const cmds = s.checks.map((c) => c.command);
    expect(cmds.filter((c) => c.includes("memberInfo"))).toEqual([`cast call ${s.pot} "memberInfo(address)((bool,uint256,uint128,uint32,uint64,uint128))" ${s.spender} --block ${s.block - 1n} --rpc-url https://rpc.testnet.chain.robinhood.com`, `cast call ${s.pot} "memberInfo(address)((bool,uint256,uint128,uint32,uint64,uint128))" ${s.spender} --block ${s.block} --rpc-url https://rpc.testnet.chain.robinhood.com`]);
    expect(cmds.filter((c) => c.includes(`balanceOf(address)(uint256)" ${s.to}`))).toHaveLength(2);
  });

  test("a deposit is not a spend", async () => {
    expect((await getJson(publicServer(), `/v1/receipts/spend/${recorded.kinds.Deposited}`)).body.error.message).toBe("This transaction has no Cofer allowance spend.");
  });
});
