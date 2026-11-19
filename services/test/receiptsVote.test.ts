import { describe, expect, test } from "bun:test";
import { hashTypedData, type Hex } from "viem";
import { potEvm } from "./evm";
import { voteReceipt } from "../src/core/voteReceipt";
import { EVM_POT, fakeVoteReceipts, getJson, publicServer, VOTE_ROW, VOTE_SIGNERS } from "./publicApiHarness";

const DIGEST = `0x${"ab".repeat(32)}` as Hex;

describe("GET /v1/receipts/vote/:digest", () => {
  test("the digest made again from the signed fields equals the compiled group account's hashProposal", async () => {
    const evm = await potEvm(4663);
    const onchain = await evm.call("hashProposal", [VOTE_ROW.kind, VOTE_ROW.data, BigInt(VOTE_ROW.nonce), VOTE_ROW.epoch, BigInt(VOTE_ROW.deadline)]);
    const r = (await voteReceipt(onchain, fakeVoteReceipts()))!;
    expect(r.digestMatches).toBe(true);
    const m = r.signed.message;
    expect(hashTypedData({ ...r.signed, types: r.signed.types as never, message: { ...m, nonce: BigInt(m.nonce), epoch: BigInt(m.epoch), deadline: BigInt(m.deadline) } } as never)).toBe(onchain);
    expect(r.signed.domain).toEqual({ name: "Cofer", version: "1", chainId: 4663, verifyingContract: "0x000000000000000000000000000000000000c0Fe" });
  });

  test("a digest that does not match the fields says so", async () => {
    expect((await voteReceipt(DIGEST, fakeVoteReceipts()))!.digestMatches).toBe(false);
  });

  test("who approved, which approvals still verify, and which were withdrawn", async () => {
    const r = await getJson(publicServer(), `/v1/receipts/vote/${DIGEST}`);
    expect(r.status).toBe(200);
    expect(r.body.data.approvals).toEqual([
      { signer: VOTE_SIGNERS[0], signature: "0x01", withdrawn: false, stillValid: true },
      { signer: VOTE_SIGNERS[1], signature: "0x02", withdrawn: false, stillValid: false },
      { signer: VOTE_SIGNERS[2], signature: "0x03", withdrawn: true, stillValid: null },
    ]);
    expect(r.body.data).toMatchObject({ kind: "vote", action: "send", state: "open", pot: "0x000000000000000000000000000000000000c0Fe" });
    expect(r.body.data.checks[0].command).toBe(`cast call 0x000000000000000000000000000000000000c0Fe "hashProposal(uint8,bytes,uint256,uint64,uint64)(bytes32)" 0 ${VOTE_ROW.data} 42 7 2000000000 --rpc-url https://rpc.mainnet.chain.robinhood.com`);
    expect(JSON.stringify(r.body)).not.toMatch(/username|proposer|chat|title|@/i);
  });

  test("an unknown vote is 404; a malformed id is 400", async () => {
    const app = publicServer(undefined);
    expect((await getJson(app, "/v1/receipts/vote/0x12")).status).toBe(400);
    const none = publicServer((await import("./publicApiHarness")).fakePublicApi({ voteReceipts: fakeVoteReceipts({ vote: async () => null }) }));
    expect((await getJson(none, `/v1/receipts/vote/${DIGEST}`)).status).toBe(404);
  });

  test("the test pot is the EVM's", () => {
    expect(EVM_POT).toBe("0x000000000000000000000000000000000000c0fe");
  });
});
