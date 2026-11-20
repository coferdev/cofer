import { describe, expect, test } from "bun:test";
import { ROUTES } from "../src/publicapi/openapi";
import { publicServer } from "./publicApiHarness";

describe("GET /llms.txt and /v1/llms.txt", () => {
  test("both answer the same plain text, listing every call in the OpenAPI description", async () => {
    const app = publicServer();
    const top = await app.request("/llms.txt");
    const v1 = await app.request("/v1/llms.txt");
    expect(top.status).toBe(200);
    expect(top.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const text = await top.text();
    expect(await v1.text()).toBe(text);
    for (const r of ROUTES) expect(text).toContain(`GET ${r.path}`);
    expect(text).toContain("(https://sign.example/v1/pots/<pot>)");
  });

  test("it states the rules: read-only, on-chain only, balances only, exits never paused", async () => {
    const text = await (await publicServer().request("/llms.txt")).text();
    for (const rule of ["Read-only: GET only", "Never a Telegram name, username, id or chat id", "Balances only", "Exits can never be paused"]) expect(text).toContain(rule);
  });
});
