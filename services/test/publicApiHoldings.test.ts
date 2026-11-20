import { describe, expect, test } from "bun:test";
import { rangeParams } from "../src/publicapi/holdings";
import { getJson, NOW, POT, publicServer, T_TSTA, T_USDG } from "./publicApiHarness";

describe("GET /v1/pots/:pot/holdings", () => {
  test("raw balances per token, day by day, with the block each day was read at", async () => {
    const r = await getJson(publicServer(), `/v1/pots/${POT}/holdings?from=2027-01-14&to=2027-01-15`);
    expect(r.status).toBe(200);
    expect(r.body.data.days.map((d: { day: string }) => d.day)).toEqual(["2027-01-14", "2027-01-15"]);
    expect(r.body.data.days[1]).toEqual({
      day: "2027-01-15",
      block: "151728000",
      blockTime: Date.parse("2027-01-15T00:00:01Z") / 1000,
      balances: [
        { asset: T_USDG, symbol: "USDG", decimals: 6, rawBalance: "25000002" },
        { asset: T_TSTA, symbol: "TSTA", decimals: 18, rawBalance: "100000000000000000" },
      ].sort((a, b) => a.asset.localeCompare(b.asset)),
    });
  });

  test("balances only: no price, value or total anywhere", async () => {
    const body = JSON.stringify((await getJson(publicServer(), `/v1/pots/${POT}/holdings`)).body);
    expect(body).not.toMatch(/price|value|total|usd"/i);
  });

  test("range rules: default last 30 days, at most 366, dates checked", () => {
    expect(rangeParams(undefined, undefined, NOW)).toEqual({ from: "2026-12-17", to: "2027-01-15" });
    expect(rangeParams("2026-01-01", "2027-01-15", NOW)).toEqual({ why: "At most 366 days per request." });
    expect(rangeParams("2027-01-15", "2027-01-14", NOW)).toEqual({ why: "from must not be after to." });
    expect(rangeParams("2027-02-30", undefined, NOW)).toEqual({ why: "from and to are dates like 2026-12-01." });
  });

  test("a bad range is 400; an unknown group 404", async () => {
    const app = publicServer();
    expect((await getJson(app, `/v1/pots/${POT}/holdings?from=yesterday`)).status).toBe(400);
    expect((await getJson(app, "/v1/pots/0x0000000000000000000000000000000000000abc/holdings")).status).toBe(404);
  });
});
