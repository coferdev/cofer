import { describe, expect, test } from "bun:test";
import { ROUTES } from "../src/publicapi/openapi";
import { getJson, publicServer } from "./publicApiHarness";

/** Every GET route the server answers under /v1, written the OpenAPI way (/v1/pots/{pot}). */
function served(): string[] {
  const app = publicServer() as unknown as { routes: { method: string; path: string }[] };
  return [...new Set(app.routes.filter((r) => r.method === "GET" && r.path.startsWith("/v1/") && !r.path.includes("*")).map((r) => r.path.replace(/:(\w+)/g, "{$1}")))].sort();
}

describe("GET /v1/openapi.json", () => {
  test("every route the server answers is in the description, and every described route is answered", () => {
    expect(ROUTES.map((r) => r.path).sort()).toEqual(served());
  });

  test("a valid OpenAPI 3.1 document, with each JSON answer's fields", async () => {
    const r = await getJson(publicServer(), "/v1/openapi.json");
    expect(r.status).toBe(200);
    expect(r.body.openapi).toBe("3.1.0");
    expect(r.body.servers).toEqual([{ url: "https://sign.example" }]);
    const pot = r.body.paths["/v1/pots/{pot}"].get;
    expect(pot.parameters[0]).toMatchObject({ name: "pot", in: "path", required: true });
    expect(pot.responses["200"].content["application/json"].schema.properties.data.required).toContain("voteRule");
    expect(r.body.paths["/v1/badge.svg"].get.responses["200"].content).toEqual({ "image/svg+xml": {} });
    expect(r.body.info.description).toContain("never a Telegram name, id or chat id");
  });

  test("the declared fields are the fields the API really sends", async () => {
    const app = publicServer();
    const samples: Record<string, string> = {
      "/v1/status": "/v1/status",
      "/v1/proof/ownership": "/v1/proof/ownership",
      "/v1/pots/{pot}": "/v1/pots/0x362B6794E6374b400aA186C1a67AC2c060af2E50",
      "/v1/admin/pending": "/v1/admin/pending",
    };
    for (const [path, url] of Object.entries(samples)) {
      const declared = ROUTES.find((r) => r.path === path)!.data as string[];
      expect(Object.keys((await getJson(app, url)).body.data).sort(), path).toEqual([...declared].sort());
    }
  });
});
