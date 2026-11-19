import { describe, expect, test } from "bun:test";
import { afterParam } from "../src/publicapi/timeline";
import { fakePublicApi, fakeTimeline, getJson, POT, potEventRows, publicServer } from "./publicApiHarness";

describe("GET /v1/pots/:pot/timeline", () => {
  test("every action in block order, with its transaction and plain words; unknown events left out", async () => {
    const r = await getJson(publicServer(), `/v1/pots/${POT}/timeline?limit=200`);
    expect(r.status).toBe(200);
    const ev = r.body.data.events;
    expect(ev.map((e: { event: string }) => e.event)).toEqual(potEventRows().filter((x) => x.name !== "SomethingNew").map((x) => x.name));
    const blocks = ev.map((e: { block: string; logIndex: number }) => [BigInt(e.block), e.logIndex]);
    for (let i = 1; i < blocks.length; i++) expect(blocks[i - 1][0] < blocks[i][0] || (blocks[i - 1][0] === blocks[i][0] && blocks[i - 1][1] < blocks[i][1])).toBe(true);
    const queued = ev.find((e: { event: string }) => e.event === "ProposalQueued");
    expect(queued.kind).toBe("vote queued");
    expect(queued.text).toContain("it can run after 2026-11-08 00:53 UTC");
    expect(queued.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(ev.find((e: { event: string }) => e.event === "AllowanceSet").text).toContain("now has an allowance of 5 USDG every 168 h");
    expect(JSON.stringify(r.body)).not.toContain("SomethingNew");
    expect(r.body.data.next).toBeNull();
  });

  test("paging is stable: a page is the same before and after newer events arrive", async () => {
    const rows = potEventRows().slice(0, -1);
    const app = publicServer(fakePublicApi({ timeline: fakeTimeline(rows) }));
    const one = await getJson(app, `/v1/pots/${POT}/timeline?limit=2`);
    expect(one.body.data.events.length).toBe(2);
    const next = one.body.data.next;
    expect(next).toMatch(/^\d+-\d+$/);
    const two = await getJson(app, `/v1/pots/${POT}/timeline?limit=2&after=${next}`);
    const grown = publicServer(fakePublicApi({ timeline: fakeTimeline([...rows, { block: 999_999_999n, logIndex: 1, txHash: `0x${"aa".repeat(32)}`, name: "MemberRemoved", args: { member: "0x00000000000000000000000000000000000000d1" } }]) }));
    const twoAgain = await getJson(grown, `/v1/pots/${POT}/timeline?limit=2&after=${next}`);
    expect(twoAgain.body.data.events).toEqual(two.body.data.events);
    const all = await getJson(grown, `/v1/pots/${POT}/timeline?limit=200`);
    expect(all.body.data.events.at(-1).text).toBe(`0x00000000000000000000000000000000000000D1 is no longer a member of group account ${POT}.`);
  });

  test("a bad cursor or limit is 400; an unknown group is 404", async () => {
    const app = publicServer();
    expect((await getJson(app, `/v1/pots/${POT}/timeline?after=abc`)).status).toBe(400);
    expect((await getJson(app, `/v1/pots/${POT}/timeline?limit=0`)).status).toBe(400);
    expect((await getJson(app, "/v1/pots/0x0000000000000000000000000000000000000abc/timeline")).status).toBe(404);
    expect(afterParam("153947820-4")).toEqual({ block: 153947820n, logIndex: 4 });
    expect(afterParam("")).toBeNull();
  });
});
