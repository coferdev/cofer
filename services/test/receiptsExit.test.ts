import { describe, expect, test } from "bun:test";
import recorded from "./fixtures/tx-receipts-46630.json";
import { exitReceipt } from "../src/core/receipts";
import { EXIT_POT, EXITER, fakeReceipts, getJson, publicServer, recordedReceipt, SET_ASIDE_EXIT_TX, setAsideExit, T_TSTA, T_USDG } from "./publicApiHarness";

const d = fakeReceipts();

describe("GET /v1/receipts/exit/:tx", () => {
  test("a recorded testnet exit: member, destination, shares burned, every amount", async () => {
    const r = await getJson(publicServer(), `/v1/receipts/exit/${recorded.kinds.Exited}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({
      kind: "exit",
      chainId: 46630,
      tx: recorded.kinds.Exited,
      pot: EXIT_POT,
      member: EXITER,
      to: EXITER,
      sharesBurned: "100000000000000000000",
      assets: [{ asset: T_USDG, symbol: "USDG", decimals: 6, amount: "90000000", sent: "90000000", setAside: "0" }],
    });
    expect(r.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  test("a set-aside token: its share, what was sent and what was set aside add up from the logs", async () => {
    const e = (await exitReceipt(setAsideExit(), d))!;
    expect(e.assets).toEqual([
      { asset: T_USDG, symbol: "USDG", decimals: 6, amount: 4_500_000n, sent: 4_500_000n, setAside: 0n },
      { asset: T_TSTA, symbol: "TSTA", decimals: 18, amount: 2n * 10n ** 17n, sent: 0n, setAside: 2n * 10n ** 17n },
    ]);
    for (const a of e.assets) expect(a.sent + a.setAside).toBe(a.amount);
  });

  test("the checks name the exact blocks and calls", async () => {
    const e = (await exitReceipt(setAsideExit(), d))!;
    const cmds = e.checks.map((c) => c.command);
    expect(cmds[0]).toBe(`cast receipt ${SET_ASIDE_EXIT_TX} --rpc-url https://rpc.testnet.chain.robinhood.com`);
    expect(cmds).toContain(`cast call ${EXIT_POT} "totalShares()(uint256)" --block 149999999 --rpc-url https://rpc.testnet.chain.robinhood.com`);
    expect(cmds).toContain(`cast call ${EXIT_POT} "distributable(address)(uint256)" ${T_TSTA} --block 149999999 --rpc-url https://rpc.testnet.chain.robinhood.com`);
    expect(cmds).toContain(`cast call ${EXIT_POT} "owed(address,address)(uint256)" ${T_TSTA} ${EXITER} --block 150000000 --rpc-url https://rpc.testnet.chain.robinhood.com`);
    expect(cmds.filter((c) => c.includes("balanceOf"))).toHaveLength(4);
  });

  test("not an exit, an unknown hash and a bad hash", async () => {
    const app = publicServer();
    const dep = await getJson(app, `/v1/receipts/exit/${recorded.kinds.Deposited}`);
    expect(dep.status).toBe(404);
    expect(dep.body.error.message).toBe("This transaction has no Cofer exit.");
    expect((await getJson(app, `/v1/receipts/exit/0x${"00".repeat(32)}`)).status).toBe(404);
    expect((await getJson(app, "/v1/receipts/exit/0x12")).status).toBe(400);
  });

  test("an Exited log from an address the factory did not make is no receipt", async () => {
    const fake = setAsideExit();
    fake.logs = fake.logs.map((l) => ({ ...l, address: "0x00000000000000000000000000000000000000f1" }));
    expect(await exitReceipt(fake, d)).toBeNull();
  });

  test("the recorded fixture itself", () => {
    expect(recordedReceipt(recorded.kinds.Exited).status).toBe("success");
  });
});
