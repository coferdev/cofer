import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { atomFeed, jsonFeed, parseChangelog } from "../src/publicapi/changelog";
import { publicServer, SAMPLE_CHANGELOG } from "./publicApiHarness";

/** Well-formed XML for the feed's simple shape: every tag closed in order, no stray "<" or "&". */
function wellFormed(x: string): boolean {
  const body = x.replace(/^<\?xml[^>]*\?>\n?/, "");
  if (/&(?!amp;|lt;|gt;|quot;|#\d+;)/.test(body)) return false;
  const stack: string[] = [];
  for (const m of body.matchAll(/<(\/?)([A-Za-z][\w:-]*)([^<>]*?)(\/?)>/g)) {
    if (m[4]) continue; // <link .../>
    if (m[1]) {
      if (stack.pop() !== m[2]) return false;
    } else stack.push(m[2]!);
  }
  return stack.length === 0 && !/<(?![A-Za-z/?])/.test(body);
}

describe("release notes feed", () => {
  test("the real CHANGELOG.md parses: its released version is an entry", () => {
    const md = readFileSync(new URL("../../CHANGELOG.md", import.meta.url), "utf8");
    const e = parseChangelog(md);
    expect(e.some((x) => x.id === "tag:getcofer.com,2026:v0.1.0" && x.updated === "2026-10-31T00:00:00Z" && x.text.length > 50)).toBe(true);
  });

  test("tech update lines become entries linking their GitHub release, newest first", () => {
    const e = parseChangelog(SAMPLE_CHANGELOG);
    expect(e.map((x) => [x.title, x.updated])).toEqual([
      ["Update 02: Status badge", "2026-12-01T15:00:00Z"],
      ["Update 01: Public status endpoint", "2026-12-01T14:00:00Z"],
      ["Cofer 0.1.0", "2026-10-31T00:00:00Z"],
    ]);
    expect(e[0]!.url).toBe("https://github.com/coferdev/cofer/releases/tag/update-02");
    expect(e[0]!.text).toBe("Status badge: Indexer live or behind, and which chain.");
  });

  test("valid Atom: well-formed, escaped, one entry each", () => {
    const x = atomFeed(parseChangelog(SAMPLE_CHANGELOG), "https://sign.example/");
    expect(wellFormed(x)).toBe(true);
    expect(x).toContain('<link rel="self" type="application/atom+xml" href="https://sign.example/v1/changelog.atom"/>');
    expect(x).toContain("<updated>2026-12-01T15:00:00Z</updated>");
    expect(x).toContain("&lt;script&gt;not a tag&lt;/script&gt; &amp; more.");
    expect(x.match(/<entry>/g)!.length).toBe(3);
    expect(wellFormed("<feed><entry></feed>")).toBe(false);
  });

  test("JSON Feed 1.1", () => {
    const j = jsonFeed(parseChangelog(SAMPLE_CHANGELOG), "https://sign.example");
    expect(j.version).toBe("https://jsonfeed.org/version/1.1");
    expect(j.feed_url).toBe("https://sign.example/v1/changelog.json");
    expect(j.items[0]).toEqual({ id: "tag:getcofer.com,2026:update-02", url: "https://github.com/coferdev/cofer/releases/tag/update-02", title: "Update 02: Status badge", content_text: "Status badge: Indexer live or behind, and which chain.", date_published: "2026-12-01T15:00:00Z" });
  });

  test("served with feed types, CORS and caching; an empty changelog gives an empty feed", async () => {
    const app = publicServer();
    const a = await app.request("/v1/changelog.atom");
    expect(a.headers.get("content-type")).toBe("application/atom+xml; charset=utf-8");
    expect(a.headers.get("access-control-allow-origin")).toBe("*");
    expect(a.headers.get("cache-control")).toBe("public, max-age=300");
    const j = await app.request("/v1/changelog.json");
    expect(j.headers.get("content-type")).toBe("application/feed+json; charset=utf-8");
    expect((await j.json()).items.length).toBe(3);
    expect(wellFormed(atomFeed(parseChangelog(""), "https://s"))).toBe(true);
  });
});
