import { describe, expect, test } from "bun:test";
import { limitParam } from "../src/publicapi/members";
import { getJson, POT, publicServer } from "./publicApiHarness";

describe("GET /v1/pots/:pot/members", () => {
  test("every member by address: active, shares and join block; no names", async () => {
    const r = await getJson(publicServer(), `/v1/pots/${POT}/members`);
    expect(r.status).toBe(200);
    expect(r.body.data.members.map((m: { address: string; active: boolean }) => [m.address, m.active])).toEqual([
      ["0x00000000000000000000000000000000000000D1", false],
      ["0x215Ea29bE890960586CEc7e35B381F6599f955aa", true],
      ["0x6c57Cad77abE08317aB9714cF8f6CF3955775A68", true],
      ["0x8251FA75f4982cDCB4bE015B9F7Ba20116a1596C", true],
    ]);
    expect(r.body.data.members[1]).toEqual({ address: "0x215Ea29bE890960586CEc7e35B381F6599f955aa", active: true, shares: "10000000000000000000", joinBlock: "147500001" });
    expect(r.body.data.next).toBeNull();
    expect(JSON.stringify(r.body)).not.toMatch(/username|tg|chat|title|@/i);
  });

  test("pages follow address order with a stable next", async () => {
    const app = publicServer();
    const one = await getJson(app, `/v1/pots/${POT}/members?limit=2`);
    expect(one.body.data.members.length).toBe(2);
    expect(one.body.data.next).toBe("0x215Ea29bE890960586CEc7e35B381F6599f955aa");
    const two = await getJson(app, `/v1/pots/${POT}/members?limit=2&after=${one.body.data.next}`);
    expect(two.body.data.members.map((m: { address: string }) => m.address)).toEqual(["0x6c57Cad77abE08317aB9714cF8f6CF3955775A68", "0x8251FA75f4982cDCB4bE015B9F7Ba20116a1596C"]);
    expect(two.body.data.next).toBeNull();
  });

  test("bad limit or after is 400; an unknown group is 404", async () => {
    const app = publicServer();
    expect((await getJson(app, `/v1/pots/${POT}/members?limit=0`)).status).toBe(400);
    expect((await getJson(app, `/v1/pots/${POT}/members?limit=500`)).status).toBe(400);
    expect((await getJson(app, `/v1/pots/${POT}/members?after=zzz`)).status).toBe(400);
    expect((await getJson(app, "/v1/pots/0x0000000000000000000000000000000000000abc/members")).status).toBe(404);
  });

  test("limit parsing", () => {
    expect([limitParam(undefined, 50, 200), limitParam("1", 50, 200), limitParam("200", 50, 200), limitParam("201", 50, 200), limitParam("-1", 50, 200), limitParam("1.5", 50, 200)]).toEqual([50, 1, 200, null, null, null]);
  });
});
