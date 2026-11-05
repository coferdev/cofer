import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  GROUP_ANONYMOUS_BOT_ID,
  NEWPOT_ADMINS_ONLY_TEXT,
  NEWPOT_ANONYMOUS_TEXT,
  NEWPOT_ROLE_UNKNOWN_TEXT,
  newpotAdminRefusal,
} from "../src/bot/newpotAdmin";
import { helpText } from "../src/bot/help";

const GROUP = -1001234567890;
const role = (status: string) => async () => status;

describe("audit v2 L-2: who may run /newpot", () => {
  test("the group's creator and its administrators may", async () => {
    expect(await newpotAdminRefusal({ fromId: 42 }, role("creator"))).toBeNull();
    expect(await newpotAdminRefusal({ fromId: 42 }, role("administrator"))).toBeNull();
  });

  test("anyone else is refused: members, restricted, left and banned users", async () => {
    for (const s of ["member", "restricted", "left", "kicked"]) {
      expect(await newpotAdminRefusal({ fromId: 42 }, role(s))).toBe(NEWPOT_ADMINS_ONLY_TEXT);
    }
  });

  test("a failed role lookup refuses (never a guess) and says nothing was created", async () => {
    const r = await newpotAdminRefusal({ fromId: 42 }, async () => {
      throw new Error("Bad Request: chat not found");
    });
    expect(r).toBe(NEWPOT_ROLE_UNKNOWN_TEXT);
    expect(r).toContain("Nothing was created");
  });
});

describe('audit v2 L-2: an admin with "Remain anonymous" on', () => {
  test("posting as the group (GroupAnonymousBot with sender_chat = the group) is refused, and their role is never looked up", async () => {
    let asked = false;
    const r = await newpotAdminRefusal({ fromId: GROUP_ANONYMOUS_BOT_ID, senderChatId: GROUP }, async () => {
      asked = true;
      return "administrator";
    });
    expect(r).toBe(NEWPOT_ANONYMOUS_TEXT);
    expect(asked).toBe(false);
  });

  test("the message says how to fix it: turn off Remain anonymous, run /newpot again", () => {
    expect(NEWPOT_ANONYMOUS_TEXT).toContain('Turn off "Remain anonymous"');
    expect(NEWPOT_ANONYMOUS_TEXT).toContain("run /newpot again");
  });

  test("GroupAnonymousBot's id is Telegram's fixed one", () => {
    expect(GROUP_ANONYMOUS_BOT_ID).toBe(1087968824);
  });

  test("either sign alone is enough: the anonymous sender id, or any sender_chat (e.g. a linked channel)", async () => {
    expect(await newpotAdminRefusal({ fromId: GROUP_ANONYMOUS_BOT_ID }, role("administrator"))).toBe(NEWPOT_ANONYMOUS_TEXT);
    expect(await newpotAdminRefusal({ fromId: 777000, senderChatId: -100999 }, role("administrator"))).toBe(NEWPOT_ANONYMOUS_TEXT);
    expect(await newpotAdminRefusal({}, role("administrator"))).toBe(NEWPOT_ANONYMOUS_TEXT); // no sender at all
  });
});

describe("audit v2 L-2: /newpot in the bot", () => {
  const bot = readFileSync(join(import.meta.dir, "..", "src", "bot", "bot.ts"), "utf8");
  const handler = bot.slice(bot.indexOf('bot.command("newpot"'), bot.indexOf('bot.command("join"'));

  test("checks the admin rule first: before key setup, the per-user limit and anything the relayer pays for", () => {
    const at = (s: string) => handler.indexOf(s);
    expect(at("newpotAdminRefusal(")).toBeGreaterThan(-1);
    expect(at("newpotAdminRefusal(")).toBeLessThan(at("requireLinked(ctx)"));
    expect(at("newpotAdminRefusal(")).toBeLessThan(at("newPotRefusal("));
    expect(at("newpotAdminRefusal(")).toBeLessThan(at("writeContract"));
  });

  test("passes the sender chat and looks up the caller's own role in this group", () => {
    expect(handler).toContain("senderChatId: ctx.message?.sender_chat?.id");
    expect(handler).toContain("ctx.getChatMember(ctx.from!.id)");
  });

  test("the group /start reply and /help say it is for group admins", () => {
    expect(bot).toContain("Hi! A group admin can run /newpot to open a group account, or see /help.");
    for (const cardsOn of [false, true]) expect(helpText({ cardsOn })).toContain("/newpot open the group account (group admins)");
  });
});
