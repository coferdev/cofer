import { describe, expect, test } from "bun:test";
import { fakeAdmin, fakePublicApi, getJson, NOW, publicServer } from "./publicApiHarness";

describe("GET /v1/admin/pending", () => {
  test("each queued change in plain words, soonest first, with when it can apply", async () => {
    const r = await getJson(publicServer(), "/v1/admin/pending");
    expect(r.status).toBe(200);
    expect(r.body.data.pending.map((p: { change: string; secondsLeft: number }) => [p.change, p.secondsLeft])).toEqual([
      ["Change the swap fee to 0.4%.", 0],
      ["Use price feed 0x00000000000000000000000000000000000000A2 for TSLA (0x322F0929c4625eD5bAd873c95208D54E1c003b2d), age limit 96 h.", 7200],
    ]);
    expect(r.body.data.pending[1].canApplyAfter).toBe(NOW + 7200);
    expect(r.body.data.pending[1].canApplyAfterUtc).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d UTC$/);
  });

  test("recent applied or replaced changes are listed apart", async () => {
    const r = await getJson(publicServer(), "/v1/admin/pending");
    expect(r.body.data.recent).toHaveLength(1);
    expect(r.body.data.recent[0]).toMatchObject({ kind: "adapter", change: "Turn on swap adapter 0x00000000000000000000000000000000000000B1.", state: "applied", resolvedBlock: "190" });
  });

  test("nothing queued: empty lists", async () => {
    const r = await getJson(publicServer(fakePublicApi({ admin: fakeAdmin([]) })), "/v1/admin/pending");
    expect(r.body.data).toEqual({ pending: [], recent: [] });
  });
});
