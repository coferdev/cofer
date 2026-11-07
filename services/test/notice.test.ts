/** The statement (core/notice.ts): the owner's exact text, numbers from the code, plain text, no forbidden words. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BETA_DEPOSIT_CAP_USDG, usdgText } from "../src/core/betaCap";
import { NETWORK_NAME } from "../src/core/exitDestination";
import { NOTICE_SUBTITLE, NOTICE_TEXT, NOTICE_TITLE, noticeText } from "../src/core/notice";
import { BANNED } from "../../tools/banned-words";

// The owner's text, exactly as given.
const OWNER_TEXT = `Before you start

"Read This Statement"

Cofer is a shared money account for your Telegram group, on Robinhood Chain.

• Your key: when you set up, Cofer creates an address for you on Robinhood Chain, protected by your passkey (Face ID or fingerprint). There is no seed phrase. This bot never holds your keys or your money.
• Robinhood Chain only: send USDG to that address on Robinhood Chain only. Money sent on any other network will not arrive.
• Leaving is always open: any member can /exit at any time and get their exact share. Nobody can block it, not even us.
• Where it goes: your exit goes to your own Cofer address, or to a different address you type. That must be a wallet that supports Robinhood Chain. Many exchange deposit addresses do not.
• Your passkey is your key. There is no recovery: if you lose it and have no backup, you lose access to your money, like a lost seed phrase. Make sure your phone or browser backs up your passkeys.
• Cofer is in beta: each group is limited to 5,000 USDG while we test. Stocks can lose value. This is software for a group to manage its own money, not financial advice.`;

// The spec's "What not to say" list ("fund" in any form: funds, funded, funding, refund...). Built from
// fragments so the repo's banned-words gate does not flag this file itself.
const f = (...p: string[]) => p.join("");
const FORBIDDEN = [
  new RegExp(f("yi", "eld"), "i"),
  new RegExp(`\\b${f("a", "py")}\\b`, "i"),
  /earn/i,
  /returns/i,
  /passive income/i,
  /guarantee/i,
  /risk-free/i,
  /\bsafe/i,
  /investment club/i,
  /fund/i,
  /bank account/i,
  new RegExp(f("part", "ner"), "i"),
  /official/i,
];

describe("statement", () => {
  test("is the owner's text exactly, with today's settings", () => {
    expect(NOTICE_TEXT).toBe(OWNER_TEXT);
  });

  test('its first line is "Before you start", then a blank line, then "Read This Statement" in quotes', () => {
    const lines = NOTICE_TEXT.split("\n");
    expect(lines.slice(0, 3)).toEqual(["Before you start", "", '"Read This Statement"']);
    expect(lines.filter((l) => l !== "").slice(0, 2)).toEqual(["Before you start", '"Read This Statement"']);
    expect(NOTICE_TITLE).toBe("Before you start");
    expect(NOTICE_SUBTITLE).toBe('"Read This Statement"');
  });

  test("the network name and the beta limit come from the code", () => {
    expect(NOTICE_TEXT).toContain(`on ${NETWORK_NAME}.`);
    expect(NOTICE_TEXT).toContain(`limited to ${usdgText(BETA_DEPOSIT_CAP_USDG!)} USDG`);
    // change either setting and the text follows
    const other = noticeText(2_500_000_000n, "Test Chain");
    expect(other).toContain("limited to 2,500 USDG");
    expect(other).toContain("Test Chain only: send USDG to that address on Test Chain only.");
    expect(other).not.toContain("Robinhood Chain");
    expect(noticeText(null)).not.toMatch(/limited to|USDG while we test/);
  });

  test("plain text, within Telegram's 4096-character limit", () => {
    expect(NOTICE_TEXT.length).toBeLessThan(4096);
    expect(NOTICE_TEXT).not.toMatch(/[<>*_`\[\]]/); // nothing that reads as HTML or Markdown
    expect(NOTICE_TEXT).not.toMatch(/https?:\/\//);
  });

  test("no forbidden word, and the repo's banned-words gate passes on it", () => {
    for (const re of FORBIDDEN) expect(`${re} -> ${re.test(NOTICE_TEXT)}`).toBe(`${re} -> false`);
    for (const b of BANNED) expect(b.re.test(NOTICE_TEXT)).toBe(false);
  });

  test("the staff copy in docs/runbook.md is the same text", () => {
    const runbook = readFileSync(join(import.meta.dir, "..", "..", "docs", "runbook.md"), "utf8");
    expect(runbook).toContain(NOTICE_TEXT.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n"));
  });
});
