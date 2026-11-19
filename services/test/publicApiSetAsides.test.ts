import { describe, expect, test } from "bun:test";
import { decodeFunctionData } from "viem";
import { EXIT_POT, EXITER, getJson, publicServer, T_TSTA } from "./publicApiHarness";

const ABI = [{ type: "function", name: "claimOwed", stateMutability: "nonpayable", inputs: [{ name: "asset", type: "address" }, { name: "account", type: "address" }], outputs: [] }] as const;

describe("GET /v1/set-asides/:address", () => {
  test("open set-asides only, each with the claim to make and the check", async () => {
    const r = await getJson(publicServer(), `/v1/set-asides/${EXITER}`);
    expect(r.status).toBe(200);
    expect(r.body.data.open).toHaveLength(1);
    const o = r.body.data.open[0];
    expect(o).toMatchObject({ pot: EXIT_POT, asset: T_TSTA, symbol: "TSTA", decimals: 18, open: "150000000000000000", lastBlock: "150000100" });
    expect(o.claim.to).toBe(EXIT_POT);
    expect(decodeFunctionData({ abi: ABI, data: o.claim.data })).toEqual({ functionName: "claimOwed", args: [T_TSTA, EXITER] });
    expect(o.check).toBe(`cast call ${EXIT_POT} "owed(address,address)(uint256)" ${T_TSTA} ${EXITER} --rpc-url https://rpc.testnet.chain.robinhood.com`);
  });

  test("nothing open: an empty list; not an address: 400", async () => {
    const app = publicServer();
    expect((await getJson(app, "/v1/set-asides/0x00000000000000000000000000000000000000e1")).body.data.open).toEqual([]);
    expect((await getJson(app, "/v1/set-asides/me")).status).toBe(400);
  });
});
