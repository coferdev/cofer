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
export const PUBLIC_JSON_ROUTES = ["/v1/status", "/v1/proof/ownership", `/v1/pots/${POT}`, `/v1/pots/${POT}/members`, `/v1/pots/${POT}/votes`, `/v1/pots/${POT}/timeline`, `/v1/receipts/exit/${recorded.kinds.Exited}`, `/v1/receipts/deposit/${recorded.kinds.Deposited}`, `/v1/receipts/vote/0x${"ab".repeat(32)}`, ...recorded.receipts.map((r) => `/v1/tx/${r.transactionHash}`)];

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
      // the vote receipt carries the EIP-712 message exactly as signed: its standard "name" fields (the domain name
      // "Cofer" and the message's field names) are part of what is signed, not a person's name
      const allowed = path.startsWith("/v1/receipts/vote/") ? /^data\.signed\.(domain\.name|types\.Proposal\[\d+\]\.name)$/ : null;
      expect(fieldNameProblems(r.body).filter((p) => !allowed?.test(p))).toEqual([]);
      expect(JSON.stringify(r.body)).not.toMatch(/@\w|t\.me\//);
    });
  }
});
