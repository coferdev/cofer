/** The API reference (docs/api/reference.md) is generated, complete and up to date; the guide lists every route. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { FIELD_DOCS, referenceMarkdown, REFERENCE_PATH } from "../scripts/gen-api-docs";
import { ROUTES } from "../src/publicapi/openapi";

describe("API reference", () => {
  test("the committed reference is exactly what the generator writes", () => {
    expect(readFileSync(REFERENCE_PATH, "utf8")).toBe(referenceMarkdown());
  });

  test("every route is in it, and every answer field is defined", () => {
    const ref = readFileSync(REFERENCE_PATH, "utf8");
    for (const r of ROUTES) expect(ref).toContain(`\`GET ${r.path}\``);
    const fields = new Set(ROUTES.flatMap((r) => (Array.isArray(r.data) ? r.data : [])));
    expect([...fields].filter((f) => !FIELD_DOCS[f])).toEqual([]);
    expect(ref).toContain("balances");
    expect(ref).toContain("only, as raw token amounts with their decimals, never prices, values or totals over time");
  });

  test("the hand-written guide's route table lists every route too", () => {
    const guide = readFileSync(new URL("../../docs/api/README.md", import.meta.url), "utf8");
    const listed = (p: string) => guide.includes(p.replace(/\{(\w+)\}/g, ":$1"));
    expect(ROUTES.map((r) => r.path).filter((p) => !listed(p))).toEqual([]);
  });
});
