import { describe, expect, test } from "bun:test";
import { getJson, POT, publicServer, T_TSTA, T_USDG } from "./publicApiHarness";

describe("GET /v1/proof/snapshot/:pot", () => {
  test("every token at the block, raw balance and reserved part, each with its command", async () => {
    const r = await getJson(publicServer(), `/v1/proof/snapshot/${POT}?block=1000010`);
    expect(r.status).toBe(200);
    expect(r.body.data.readable).toBe(true);
    expect(r.body.data.block).toBe("1000010");
    const tsta = r.body.data.assets.find((a: { asset: string }) => a.asset === T_TSTA);
    expect(tsta).toMatchObject({ symbol: "TSTA", decimals: 18, rawBalance: "100000000000000000", reserved: "50000000000000000" });
    expect(tsta.checks.map((c: { command: string }) => c.command)).toEqual([
      `cast call ${T_TSTA} "balanceOf(address)(uint256)" ${POT} --block 1000010 --rpc-url https://rpc.testnet.chain.robinhood.com`,
      `cast call ${POT} "reserved(address)(uint256)" ${T_TSTA} --block 1000010 --rpc-url https://rpc.testnet.chain.robinhood.com`,
    ]);
    expect(r.body.data.assets.find((a: { asset: string }) => a.asset === T_USDG).rawBalance).toBe("25000000");
  });

  test("no block: the newest the indexer would count (head minus confirmations)", async () => {
    expect((await getJson(publicServer(), `/v1/proof/snapshot/${POT}`)).body.data.block).toBe("1000000");
  });

  test("a block the server's RPC cannot read: said plainly, with the commands for an archive RPC", async () => {
    const r = await getJson(publicServer(), `/v1/proof/snapshot/${POT}?block=5`);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ readable: false, assets: null });
    expect(r.body.data.checks[0].command).toBe(`cast call ${POT} "heldAssets()(address[])" --block 5 --rpc-url https://rpc.testnet.chain.robinhood.com`);
  });

  test("a future or malformed block is 400", async () => {
    const app = publicServer();
    expect((await getJson(app, `/v1/proof/snapshot/${POT}?block=2000000`)).body.error.message).toBe("That block is not on the chain yet (newest: 1000020).");
    expect((await getJson(app, `/v1/proof/snapshot/${POT}?block=latest`)).status).toBe(400);
  });
});
