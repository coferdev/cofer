/**
 * The guard on every public API answer: no field name about Telegram people or chats, and no wording about money
 * outcomes. Each new public route adds a sample request here.
 */
import { describe, expect, test } from "bun:test";
import { fieldNameProblems, fieldWords } from "../src/publicapi/format";
import { getJson, POT, publicServer } from "./publicApiHarness";
import recorded from "./fixtures/tx-receipts-46630.json";

/**
 * Every public JSON route with a valid sample request (later updates add theirs). The changelog feeds are not listed:
 * they follow the Atom and JSON Feed standards (whose fields include "title") and carry only CHANGELOG.md text.
 */
export const PUBLIC_JSON_ROUTES = ["/v1/status", "/v1/proof/ownership", `/v1/pots/${POT}`, `/v1/pots/${POT}/members`, `/v1/pots/${POT}/votes`, `/v1/pots/${POT}/timeline`, `/v1/receipts/exit/${recorded.kinds.Exited}`, ...recorded.receipts.map((r) => `/v1/tx/${r.transactionHash}`)];

describe("public API field names", () => {
  test("the guard splits names into words and catches forbidden ones", () => {
    expect(fieldWords("lagSeconds")).toEqual(["lag", "seconds"]);
    expect(fieldWords("tg_id")).toEqual(["tg", "id"]);
    expect(fieldNameProblems({ ok: 1, nested: [{ chatId: 1 }], approvals: 2, against: 3, totalReturn: 4, groupTitle: "x", username: "y" })).toEqual(["nested[0].chatId", "totalReturn", "groupTitle", "username"]);
  });

  for (const path of PUBLIC_JSON_ROUTES) {
    test(`${path}: no forbidden field name, no Telegram data`, async () => {
      const r = await getJson(publicServer(), path);
      expect(r.status).toBe(200);
      expect(fieldNameProblems(r.body)).toEqual([]);
      expect(JSON.stringify(r.body)).not.toMatch(/@\w|t\.me\//);
    });
  }
});
