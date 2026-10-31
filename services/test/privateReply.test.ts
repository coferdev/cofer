import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isEphemeral, privateReply, type PrivateReply, type PrivateReplyDeps } from "../src/bot/privateReply";

const GROUP = -1001234;
const MEMBER = 777;

/** A stand-in for Telegram. `group` decides what a send to the group returns (or throws). */
function fake(group: "ephemeral" | "public" | "fails", dm: "ok" | "fails" = "ok") {
  const sends: { chatId: number; text: string; opts: Record<string, unknown> }[] = [];
  const removed: number[] = [];
  const burned: string[] = [];
  const leaks: number[] = [];
  const d: PrivateReplyDeps = {
    async send(chatId, text, opts) {
      sends.push({ chatId, text, opts });
      if (chatId === GROUP) {
        if (group === "fails") throw new Error("Bad Request: ephemeral messages are not available");
        return group === "ephemeral" ? { message_id: 0, ephemeral_message_id: 5, receiver_user: { id: MEMBER, is_bot: false, first_name: "A" } } : { message_id: 42 };
      }
      if (dm === "fails") throw new Error("Forbidden: bot can't initiate conversation with a user");
      return { message_id: 9 };
    },
    async remove(_c, id) {
      removed.push(id);
    },
    async burn(href) {
      burned.push(href);
    },
    async leaked(c) {
      leaks.push(c);
    },
  };
  return { d, sends, removed, burned, leaks };
}

let n = 0;
const reply = (p: Partial<PrivateReply> = {}): PrivateReply => ({
  chatId: GROUP,
  chatType: "supergroup",
  userId: MEMBER,
  text: "Add USDG",
  link: { label: "Deposit", make: () => `https://sign.example/s/link${++n}` },
  ...p,
});
const urlOf = (s: { opts: Record<string, unknown> }) => (s.opts.reply_markup as { inline_keyboard: { url: string }[][] }).inline_keyboard[0]![0]!.url;

describe("a personal reply in a group", () => {
  test("delivered as ephemeral: sent once, to the group, only for this member", async () => {
    const f = fake("ephemeral");
    expect(await privateReply(f.d, reply({ callbackQueryId: "cb1" }))).toBe("ephemeral");
    expect(f.sends.length).toBe(1);
    expect(f.sends[0]!.opts.ephemeral_message_parameters).toEqual({ receiver_user_id: MEMBER, callback_query_id: "cb1" });
    expect(f.removed).toEqual([]);
  });

  test("Telegram refuses the ephemeral message: a DM with the same link (nobody else saw it)", async () => {
    const f = fake("fails");
    expect(await privateReply(f.d, reply())).toBe("dm");
    expect(f.sends.map((s) => s.chatId)).toEqual([GROUP, MEMBER]);
    expect(urlOf(f.sends[1]!)).toBe(urlOf(f.sends[0]!));
    expect(f.sends[1]!.opts.ephemeral_message_parameters).toBeUndefined();
    expect(f.burned).toEqual([]);
  });

  test("delivered to the WHOLE group by mistake: deleted, link cancelled, ops told, DM with a fresh link", async () => {
    const f = fake("public");
    expect(await privateReply(f.d, reply())).toBe("dm");
    expect(f.removed).toEqual([42]);
    const leakedUrl = urlOf(f.sends[0]!);
    expect(f.burned).toEqual([leakedUrl]);
    expect(f.leaks).toEqual([GROUP]);
    expect(f.sends[1]!.chatId).toBe(MEMBER);
    expect(urlOf(f.sends[1]!)).not.toBe(leakedUrl); // the cancelled link is never sent again
  });

  test("a leaked message without a link (e.g. /me): deleted and reported, nothing to cancel", async () => {
    const f = fake("public");
    expect(await privateReply(f.d, reply({ link: undefined, text: "Your share: 20%" }))).toBe("dm");
    expect(f.removed).toEqual([42]);
    expect(f.burned).toEqual([]);
    expect(f.leaks).toEqual([GROUP]);
  });

  test("no DM possible (the member never started the bot): 'none', so the bot asks them to open a chat", async () => {
    const f = fake("fails", "fails");
    expect(await privateReply(f.d, reply())).toBe("none");
  });

  test("a failed delete or cancel still ends in a DM and a report", async () => {
    const f = fake("public");
    f.d.remove = async () => Promise.reject(new Error("can't delete"));
    f.d.burn = async () => Promise.reject(new Error("db down"));
    expect(await privateReply(f.d, reply())).toBe("dm");
    expect(f.leaks).toEqual([GROUP]);
  });
});

describe("in a private chat", () => {
  test("sent directly, with no ephemeral parameters", async () => {
    const f = fake("ephemeral");
    expect(await privateReply(f.d, reply({ chatId: MEMBER, chatType: "private" }))).toBe("dm");
    expect(f.sends.length).toBe(1);
    expect(f.sends[0]!.opts.ephemeral_message_parameters).toBeUndefined();
  });
});

describe("what counts as ephemeral", () => {
  test("message_id 0, an ephemeral id, or this member as receiver; anything else is public", () => {
    expect(isEphemeral({ message_id: 0 }, MEMBER)).toBe(true);
    expect(isEphemeral({ message_id: 3, ephemeral_message_id: 1 }, MEMBER)).toBe(true);
    expect(isEphemeral({ message_id: 3, receiver_user: { id: MEMBER, is_bot: false, first_name: "A" } }, MEMBER)).toBe(true);
    expect(isEphemeral({ message_id: 3 }, MEMBER)).toBe(false);
    expect(isEphemeral({ message_id: 3, receiver_user: { id: 1, is_bot: false, first_name: "B" } }, MEMBER)).toBe(false);
  });
});

describe("wiring", () => {
  const bot = readFileSync(join(import.meta.dir, "..", "src", "bot", "bot.ts"), "utf8");
  test("every personal link is made fresh through privateReply, never sent as a fixed link", () => {
    expect(bot).not.toMatch(/href: signerUrl\(/);
    expect(bot.match(/make: \(\) => signerUrl\(/g)?.length).toBe(8);
    expect(bot).toContain("const r = await privateReply(privateDeps(ctx),");
    expect(bot).not.toContain("ephemeral_message_parameters"); // only privateReply.ts sets it
  });

  test("a leaked link is cancelled by marking it used, the same record the signer site checks", () => {
    expect(bot).toMatch(/async function burnLink[\s\S]*?insert\(schema\.linkTokens\)[\s\S]*?usedAt: now/);
  });
});
