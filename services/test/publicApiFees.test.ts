import { describe, expect, test } from "bun:test";
import { getJson, POT, publicServer, T_TSTA, T_USDG } from "./publicApiHarness";

describe("GET /v1/pots/:pot/fees", () => {
  test("every swap fee and plan payment, oldest first, each with its transaction", async () => {
    const r = await getJson(publicServer(), `/v1/pots/${POT}/fees`);
    expect(r.status).toBe(200);
    expect(r.body.data.fees.map((f: { kind: string; asset: string; amount: string }) => [f.kind, f.asset, f.amount])).toEqual([
      ["swap fee", T_USDG, "150000"],
      ["plan", T_USDG, "27000000"],
      ["swap fee", T_TSTA, "3000000000000000"],
    ]);
    expect(r.body.data.fees[1]).toMatchObject({ symbol: "USDG", decimals: 6, months: 3, block: "401", logIndex: 2, tx: `0x${"f2".repeat(32)}` });
    expect(r.body.data.next).toBeNull();
  });

  test("pages by block and log index", async () => {
    const app = publicServer();
    const one = await getJson(app, `/v1/pots/${POT}/fees?limit=2`);
    expect(one.body.data.next).toBe("401-2");
    const two = await getJson(app, `/v1/pots/${POT}/fees?limit=2&after=401-2`);
    expect(two.body.data.fees.map((f: { block: string }) => f.block)).toEqual(["402"]);
  });

  test("bad cursor 400; unknown group 404", async () => {
    const app = publicServer();
    expect((await getJson(app, `/v1/pots/${POT}/fees?after=x`)).status).toBe(400);
    expect((await getJson(app, "/v1/pots/0x0000000000000000000000000000000000000abc/fees")).status).toBe(404);
  });
});
