import { describe, expect, test } from "bun:test";
import { getJson, POT, POT_MEMBERS, publicServer } from "./publicApiHarness";

describe("GET /v1/members/:address", () => {
  test("a key in several groups: each with its shares and join block", async () => {
    const r = await getJson(publicServer(), `/v1/members/${POT_MEMBERS[1]}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({
      address: POT_MEMBERS[1],
      groups: [
        { pot: POT, shares: "15000000000000000000", joinBlock: "147600000" },
        { pot: "0x867851A44059BC0dB4202E78ecdC97bF55d8776e", shares: "1", joinBlock: "147600001" },
      ],
    });
  });

  test("a key in one group, and a key in none", async () => {
    const app = publicServer();
    expect((await getJson(app, `/v1/members/${POT_MEMBERS[0]!.toLowerCase()}`)).body.data.groups).toEqual([{ pot: POT, shares: "10000000000000000000", joinBlock: "147600000" }]);
    expect((await getJson(app, "/v1/members/0x00000000000000000000000000000000000000e1")).body.data).toEqual({ address: "0x00000000000000000000000000000000000000e1", groups: [] });
  });

  test("not an address is 400; never a name", async () => {
    const app = publicServer();
    expect((await getJson(app, "/v1/members/alice")).status).toBe(400);
    expect(JSON.stringify((await getJson(app, `/v1/members/${POT_MEMBERS[1]}`)).body)).not.toMatch(/username|tg|chat|title|@/i);
  });
});
