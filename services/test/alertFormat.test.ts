import { describe, expect, test } from "bun:test";
import { addressBook, alertName, alertText, clearedText, nameOf, reminderText, scrubHex, shortHex, txLink, WHO } from "../src/core/alertFormat";
import { parseEnv } from "../src/env";

const OWNER = "0x5ACD09eAe4f160e2f2e2356e6eF0496EF6f0f064";
const GUARDIAN = "0x1111111111111111111111111111111111111111";
const RELAYER = "0x2222222222222222222222222222222222222222";
const TSLA = "0x3333333333333333333333333333333333333333";
const STRANGER = "0x9876543210abcdef9876543210abcdef98765432";
const TX = `0x${"ab".repeat(32)}`;
const FULL_ADDRESS = /0x[0-9a-fA-F]{40}/;

const book = addressBook({ owner: OWNER, guardian: GUARDIAN, feeWallet: GUARDIAN, relayer: RELAYER }, { [TSLA]: "TSLA" });

describe("alert format", () => {
  test("starts with the prefix and name, then what happened, then who acts", () => {
    const t = alertText({ name: "indexer-behind", what: "The indexer is 12m behind the chain.", who: WHO.dev });
    expect(t).toBe("[cofer alert] indexer-behind\nThe indexer is 12m behind the chain.\nWho acts: Dev checks.");
  });

  test("an emergency is marked", () => {
    const t = alertText({ name: "role-changed", what: "x", who: WHO.emergency, emergency: true });
    expect(t.split("\n")[0]).toBe("[cofer alert] role-changed (EMERGENCY)");
    expect(t).toContain("Who acts: Emergency: tell the owner and the dev at once.");
  });

  test("known addresses become role names or symbols, case-insensitively", () => {
    expect(nameOf(book, OWNER.toLowerCase())).toBe("owner Safe");
    expect(nameOf(book, GUARDIAN)).toBe("guardian and fee wallet");
    expect(nameOf(book, TSLA)).toBe("TSLA");
    expect(nameOf(book, STRANGER)).toBe("0x9876…5432");
  });

  test("no full address or hash survives, except the one kept", () => {
    const what = `Owner ${OWNER} moved to ${STRANGER}; vote ${TX}. Send ETH to ${RELAYER}.`;
    const t = alertText({ name: "x", what, who: WHO.dev }, { book });
    expect(t).not.toMatch(FULL_ADDRESS);
    expect(t).toContain("Owner owner Safe moved to 0x9876…5432; vote 0xabab…abab.");
    const kept = alertText({ name: "relayer-low", what: `Send ETH to ${RELAYER}.`, who: WHO.topUp }, { book, keep: RELAYER });
    expect(kept).toContain(RELAYER);
  });

  test("a transaction is an explorer link, or a short hash with no explorer set", () => {
    expect(txLink("https://explorer.example/", TX)).toBe(`https://explorer.example/tx/${TX}`);
    expect(txLink(undefined, TX)).toBe("Transaction 0xabab…abab.");
    const t = alertText({ name: "admin-change", what: "Deposits paused.", who: WHO.none, tx: TX }, { explorer: "https://explorer.example" });
    expect(t.split("\n").at(-1)).toBe(`https://explorer.example/tx/${TX}`);
  });

  test("other URLs in the text are removed (they can hold keys)", () => {
    const t = alertText({ name: "rpc-down", what: "Failed at https://rpc.example/KEY123.", who: WHO.dev });
    expect(t).not.toContain("KEY123");
  });

  test("names: symbol appended and cleaned", () => {
    expect(alertName("price-stale", "TSLA")).toBe("price-stale-TSLA");
    expect(alertName("price-bad", "BRK.B")).toBe("price-bad-BRK.B");
    expect(alertName("price-bad", "<b>X\n")).toBe("price-bad-bX");
    expect(alertName("relayer-low")).toBe("relayer-low");
  });

  test("cleared and reminder lines", () => {
    expect(clearedText("price-stale-TSLA", "the feed updated")).toBe("[cofer alert] price-stale-TSLA: Cleared (the feed updated).");
    expect(clearedText("job-failing")).toBe("[cofer alert] job-failing: Cleared.");
    const stored = alertText({ name: "role-changed", what: "The guardian changed.", who: WHO.emergency, emergency: true });
    expect(reminderText(stored, 45 * 60)).toBe("[cofer alert] role-changed (EMERGENCY)\nStill open after 45m.\nThe guardian changed.\nWho acts: Emergency: tell the owner and the dev at once.");
    expect(reminderText(stored, 2 * 3600 + 5 * 60)).toContain("Still open after 2h 5m.");
  });

  test("short hex", () => {
    expect(shortHex(STRANGER)).toBe("0x9876…5432");
    expect(scrubHex("block 0x1234")).toBe("block 0x1234");
  });
});

describe("settings", () => {
  const base = {
    PUBLIC_URL: "https://sign.example.com",
    DATABASE_URL: "postgres://x",
    RHC_RPC_URL: "https://rpc.example",
    FACTORY_ADDRESS: OWNER,
    ADAPTER_ADDRESS: OWNER,
    RELAYER_PRIVATE_KEY: "0x01",
    TELEGRAM_BOT_TOKEN: "t",
    TELEGRAM_BOT_USERNAME: "b",
    TELEGRAM_WEBHOOK_SECRET: "s".repeat(16),
    LINK_SECRET: "s".repeat(32),
  };
  test("explorer and fee wallet are optional", () => {
    const e = parseEnv(base);
    expect(e.EXPLORER_URL).toBeUndefined();
    expect(e.EXPECTED_FEE_WALLET).toBeUndefined();
    const f = parseEnv({ ...base, EXPLORER_URL: "https://explorer.example", EXPECTED_FEE_WALLET: GUARDIAN });
    expect(f.EXPLORER_URL).toBe("https://explorer.example");
    expect(() => parseEnv({ ...base, EXPECTED_FEE_WALLET: "0x12" })).toThrow();
  });
});
