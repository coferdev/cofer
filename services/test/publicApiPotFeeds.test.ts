import { describe, expect, test } from "bun:test";
import { getJson, POT, publicServer } from "./publicApiHarness";

function wellFormed(x: string): boolean {
  const body = x.replace(/^<\?xml[^>]*\?>\n?/, "");
  if (/&(?!amp;|lt;|gt;|quot;|#\d+;)/.test(body)) return false;
  const stack: string[] = [];
  for (const m of body.matchAll(/<(\/?)([A-Za-z][\w:-]*)([^<>]*?)(\/?)>/g)) {
    if (m[4]) continue;
    if (m[1]) {
      if (stack.pop() !== m[2]) return false;
    } else stack.push(m[2]!);
  }
  return stack.length === 0;
}

describe("GET /v1/pots/:pot/feed.atom and feed.json", () => {
  test("votes and other actions as feed items, newest first, linking the transaction page", async () => {
    const r = await getJson(publicServer(), `/v1/pots/${POT}/feed.json`);
    expect(r.status).toBe(200);
    expect(r.body.version).toBe("https://jsonfeed.org/version/1.1");
    expect(r.body.items.map((i: { title: string }) => i.title)).toEqual(["Vote ran", "Vote passed, waiting for its exit window", "Vote ran"]);
    expect(r.body.items[0].url).toMatch(/^https:\/\/sign\.example\/tx\/0x[0-9a-f]{64}$/);
    expect(r.body.items[1].content_text).toContain("it can run after 2026-11-08 00:53 UTC");
    const times = r.body.items.map((i: { date_published: string }) => i.date_published);
    expect([...times].sort().reverse()).toEqual(times);
  });

  test("item ids are fixed by transaction and log: the same on every read", async () => {
    const app = publicServer();
    const a = (await getJson(app, `/v1/pots/${POT}/feed.json`)).body.items.map((i: { id: string }) => i.id);
    const b = (await getJson(publicServer(), `/v1/pots/${POT}/feed.json`)).body.items.map((i: { id: string }) => i.id);
    expect(a).toEqual(b);
    expect(a[0]).toMatch(/^tag:getcofer\.com,2026:pot:0x362b6794e6374b400aa186c1a67ac2c060af2e50:0x[0-9a-f]{64}:\d+$/);
    expect(new Set(a).size).toBe(a.length);
  });

  test("valid Atom, served with feed types; an unknown group is 404", async () => {
    const app = publicServer();
    const r = await app.request(`/v1/pots/${POT}/feed.atom`);
    expect(r.headers.get("content-type")).toBe("application/atom+xml; charset=utf-8");
    const x = await r.text();
    expect(wellFormed(x)).toBe(true);
    expect(x.match(/<entry>/g)!.length).toBe(3);
    expect((await app.request("/v1/pots/0x0000000000000000000000000000000000000abc/feed.atom")).status).toBe(404);
  });
});
