import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ambiguousText, INVALID_HANDLE_TEXT, notMemberText, parseWho, pickMember, TELEGRAM_USERNAME } from "../src/bot/resolveHandle";

const BOB = "0x00000000000000000000000000000000000B0b00";
const LOOKALIKE = "0x000000000000000000000000000000000bAD0bAD";

describe("audit v2 M-1: what may be typed as a recipient", () => {
  test("an address is used as typed", () => {
    expect(parseWho("0x00000000000000000000000000000000000b0b00")).toEqual({ kind: "address", address: BOB });
  });

  test("a Telegram username, with or without @, in any case", () => {
    expect(parseWho("@Bob_Smith")).toEqual({ kind: "handle", handle: "bob_smith" });
    expect(parseWho("bob_smith")).toEqual({ kind: "handle", handle: "bob_smith" });
  });

  test("pattern characters and anything that is not a username never reach the database", () => {
    for (const w of ["@bob%", "@%", "@bob smith", "@bo", "@" + "a".repeat(33), "@bob-smith", "@bob.smith", "@bob\\_smith", ""]) {
      expect(parseWho(w)).toEqual({ kind: "invalid" });
    }
    expect(TELEGRAM_USERNAME.test("bob_smith")).toBe(true);
    expect(INVALID_HANDLE_TEXT).toContain("0x address");
  });
});

describe("audit v2 M-1: choosing the member", () => {
  test("the look-alike 'bobxsmith' is never chosen for @bob_smith ('_' is not a wildcard)", () => {
    const r = pickMember([{ username: "bobxsmith", address: LOOKALIKE }], "bob_smith");
    expect(r).toEqual({ ok: false, text: notMemberText("bob_smith") });
  });

  test("the exact member is chosen, case-insensitively, and labelled with the stored username", () => {
    const r = pickMember(
      [
        { username: "bobxsmith", address: LOOKALIKE },
        { username: "Bob_Smith", address: BOB.toLowerCase() },
      ],
      "bob_smith",
    );
    expect(r).toEqual({ ok: true, address: BOB, label: "@Bob_Smith" });
  });

  test("two different keys under the same stored username: refused, never a guess", () => {
    const r = pickMember(
      [
        { username: "bob_smith", address: BOB },
        { username: "BOB_SMITH", address: LOOKALIKE },
      ],
      "bob_smith",
    );
    expect(r).toEqual({ ok: false, text: ambiguousText("bob_smith") });
  });

  test("the same key listed twice is still one member", () => {
    expect(pickMember([{ username: "bob_smith", address: BOB }, { username: "bob_smith", address: BOB.toLowerCase() }], "bob_smith").ok).toBe(true);
  });

  test("rows without a key or a username are ignored", () => {
    expect(pickMember([{ username: "bob_smith", address: null }, { username: null, address: BOB }], "bob_smith").ok).toBe(false);
  });

  test("the texts tell the member to use an address instead", () => {
    expect(notMemberText("bob_smith")).toContain("isn't a member of this group account");
    expect(ambiguousText("bob_smith")).toContain("0x address");
  });
});

describe("audit v2 M-1: the bot's lookup", () => {
  const bot = readFileSync(join(import.meta.dir, "..", "src", "bot", "bot.ts"), "utf8");
  const fn = bot.slice(bot.indexOf("async function resolveMember"), bot.indexOf("/** @param opts.cardsOn"));

  test("searches only this group's active members, by exact lower-case username", () => {
    expect(fn).toContain("parseWho(who)");
    expect(fn).toContain("eq(schema.members.pot, pot.address)");
    expect(fn).toContain("eq(schema.members.active, true)");
    expect(fn).toContain("sql`lower(${schema.users.username}) = ${w.handle}`");
    expect(fn).toContain("pickMember(rows, w.handle)");
    expect(fn).not.toContain("ilike");
  });

  test("voters see the stored username, never the typed text", () => {
    expect(fn).toContain("nameCache.set(pick.address.toLowerCase(), pick.label)");
    expect(fn).not.toMatch(/nameCache\.set\([^)]*handle/);
  });
});

describe("stock symbols in /buy and /sell", () => {
  const bot = readFileSync(join(import.meta.dir, "..", "src", "bot", "bot.ts"), "utf8");

  test("are matched exactly (ignoring case), never as a pattern", () => {
    const fn = bot.slice(bot.indexOf("async function findAsset"), bot.indexOf("/** CoferFactory.quote"));
    expect(fn).toContain("eq(sql`lower(${schema.assets.symbol})`, symbol.toLowerCase())");
    expect(fn).toContain("eq(schema.assets.listedOnChain, true)");
  });

  test("no pattern-match lookup is left anywhere in the bot", () => {
    expect(bot).not.toMatch(/\bilike\b/);
  });
});

