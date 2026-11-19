import { describe, expect, test } from "bun:test";
import { badgeSvg, embedSnippets } from "../src/publicapi/badge";
import { fakePublicApi, fakeStatus, publicServer } from "./publicApiHarness";

describe("GET /v1/badge.svg", () => {
  test("each state draws its own fixed image", () => {
    expect(badgeSvg(4663, "live")).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" width="223" height="20" role="img" aria-label="cofer · chain 4663: indexer live"><title>cofer · chain 4663: indexer live</title><rect width="131" height="20" rx="3" fill="#1c1c1e"/><rect x="131" width="92" height="20" rx="3" fill="#2e9e5b"/><rect x="131" width="4" height="20" fill="#2e9e5b"/><g fill="#ffffff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11"><text x="65.5" y="14" text-anchor="middle">cofer · chain 4663</text><text x="177" y="14" text-anchor="middle">indexer live</text></g></svg>',
    );
    expect(badgeSvg(46630, "behind")).toContain(">indexer behind<");
    expect(badgeSvg(46630, "behind")).toContain("chain 46630");
    expect(badgeSvg(4663, "behind")).toContain('fill="#c98a16"');
    expect(badgeSvg(4663, "not started")).toContain(">indexer not started<");
    expect(badgeSvg(4663, "unknown")).toContain(">indexer unknown<");
  });

  test("no script, no event attribute, no outside reference in any state", () => {
    for (const s of ["live", "behind", "not started", "unknown"] as const) {
      const svg = badgeSvg(4663, s);
      expect(svg).not.toMatch(/<script|\son\w+=|href=|<foreignObject|javascript:/i);
    }
  });

  test("served as SVG with a strict policy, from the cached status", async () => {
    const r = await publicServer().request("/v1/badge.svg");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(r.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'");
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(await r.text()).toContain(">indexer live<");
  });

  test("a behind indexer shows behind; a failed read shows unknown, still 200", async () => {
    const behind = publicServer(fakePublicApi({ status: fakeStatus({ cursor: async () => 900_000n }) }));
    expect(await (await behind.request("/v1/badge.svg")).text()).toContain(">indexer behind<");
    const down = publicServer(fakePublicApi({ status: fakeStatus({ head: async () => Promise.reject(new Error("rpc")) }) }));
    const r = await down.request("/v1/badge.svg");
    expect(r.status).toBe(200);
    expect(await r.text()).toContain(">indexer unknown<");
  });

  test("the embed snippets point at the badge", () => {
    expect(embedSnippets("https://sign.example/")).toEqual({ markdown: "![Cofer status](https://sign.example/v1/badge.svg)", html: '<img src="https://sign.example/v1/badge.svg" alt="Cofer status" height="20">' });
  });
});
