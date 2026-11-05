import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT_IN_PRIVATE_NOTE, EXIT_PICK_TEXT, EXIT_TEXT, exitButtonLabel, exitMenu, MAX_EXIT_BUTTONS, NO_POTS_TEXT, type ExitPot } from "../src/bot/exitList";
import { signerUrl } from "../src/bot/keyboards";
import { helpText } from "../src/bot/help";
import { onboardLinkProblem, verifyLink } from "../src/core/linkToken";

const POT_A = "0x2D3365a056074f6cd35C943EDcE644FAE7Eb8A45";
const POT_B = "0x0d6e43d4d7944408d9a5A10BC57B4348d61cD764";
const POT_C = "0xFCc4Ba754Ae127396D3c6dCA507389b5A5b6EFAe";

/** A link maker that records which pot each link was made for and makes each link different. */
function links() {
  const made: string[] = [];
  return { made, make: (pot: string) => (made.push(pot), `https://sign.example/s/${made.length}-${pot}`) };
}
const buttons = (m: ReturnType<typeof exitMenu>) => (m.keyboard?.inline_keyboard ?? []).flat();

describe("/exit in the private chat: which pots are offered", () => {
  test("in no pot: says so, no buttons", () => {
    const l = links();
    const m = exitMenu([], l.make);
    expect(m).toEqual({ text: NO_POTS_TEXT, keyboard: null });
    expect(l.made).toEqual([]);
  });

  test("in one pot: one exit button for that pot, with the group's name", () => {
    const l = links();
    const m = exitMenu([{ address: POT_A, title: "Trip fund" }], l.make);
    expect(m.text).toBe(`Trip fund\n\n${EXIT_TEXT}`);
    expect(buttons(m)).toEqual([{ text: "Exit with my share", url: `https://sign.example/s/1-${POT_A}` }]);
    expect(l.made).toEqual([POT_A]);
  });

  test("in several pots: one button per pot, sorted by name, each with its own link", () => {
    const l = links();
    const m = exitMenu(
      [
        { address: POT_B, title: "Zoo club" },
        { address: POT_A, title: "Trip fund" },
        { address: POT_C, title: "Book club" },
      ],
      l.make,
    );
    expect(m.text).toBe(EXIT_PICK_TEXT);
    const b = buttons(m);
    expect(b.map((x) => x.text)).toEqual(["Exit Book club (0xFCc4…EFAe)", "Exit Trip fund (0x2D33…8A45)", "Exit Zoo club (0x0d6e…D764)"]);
    expect(l.made).toEqual([POT_C, POT_A, POT_B]);
    const urls = b.map((x) => ("url" in x ? x.url : ""));
    expect(new Set(urls).size).toBe(3); // every link is different (one-time links are never shared)
    expect(m.keyboard!.inline_keyboard.length).toBe(3); // one per row
  });

  test("the same pot twice (any letter case) is offered once", () => {
    const l = links();
    const m = exitMenu(
      [
        { address: POT_A, title: "Trip fund" },
        { address: POT_A.toLowerCase(), title: "Trip fund" },
      ],
      l.make,
    );
    expect(buttons(m)).toHaveLength(1);
    expect(l.made).toHaveLength(1);
  });

  test("two groups with the same name are told apart by address", () => {
    const m = exitMenu(
      [
        { address: POT_A, title: "Family" },
        { address: POT_B, title: "Family" },
      ],
      links().make,
    );
    const names = buttons(m).map((x) => x.text);
    expect(names[0]).not.toBe(names[1]);
  });

  test("button labels: long names are shortened, an empty name becomes 'Group'", () => {
    expect(exitButtonLabel({ address: POT_A, title: "A very long group name that goes on" })).toBe("Exit A very long group name … (0x2D33…8A45)");
    expect(exitButtonLabel({ address: POT_A, title: "  " })).toBe("Exit Group (0x2D33…8A45)");
  });

  test("more pots than fit: the first ones are shown and the message says how many", () => {
    const pots: ExitPot[] = Array.from({ length: MAX_EXIT_BUTTONS + 10 }, (_, i) => ({ address: `0x${(i + 1).toString(16).padStart(40, "0")}`, title: `G${String(i).padStart(3, "0")}` }));
    const m = exitMenu(pots, links().make);
    expect(buttons(m)).toHaveLength(MAX_EXIT_BUTTONS);
    expect(m.text).toBe(`${EXIT_PICK_TEXT}\n\nShowing ${MAX_EXIT_BUTTONS} of ${MAX_EXIT_BUTTONS + 10}.`);
  });

  test("only plain url buttons (never a Mini App)", () => {
    const m = exitMenu(
      [
        { address: POT_A, title: "A" },
        { address: POT_B, title: "B" },
      ],
      links().make,
    );
    for (const b of buttons(m)) {
      expect(Object.keys(b).sort()).toEqual(["text", "url"]);
    }
  });
});

describe("/exit in the private chat: the link works without the group", () => {
  test("a link made in the private chat is an exit link for that pot, bound to the member", () => {
    const secret = "x".repeat(64);
    const href = signerUrl({ publicUrl: "https://sign.example", secret, tgId: 42, chatId: 42 }, "exit", POT_A);
    const c = verifyLink(new URL(href).pathname.split("/s/")[1]!, secret);
    expect([c.p, c.ref, c.tg, c.chat]).toEqual(["exit", POT_A, 42, 42]);
    expect(onboardLinkProblem(c)).toBeNull(); // only onboarding links care which chat they came from
  });
});

describe("/exit in /help", () => {
  test("says it also works in a private chat", () => {
    for (const cardsOn of [false, true]) expect(helpText({ cardsOn })).toContain("/exit take your exact share, any time (also in a private chat with me)");
  });
});

describe("/exit in the bot", () => {
  const bot = readFileSync(join(import.meta.dir, "..", "src", "bot", "bot.ts"), "utf8");
  const handler = bot.slice(bot.indexOf('bot.command("exit"'), bot.indexOf('bot.command("me"'));

  test("in the private chat it lists the member's pots from their key, before any group lookup", () => {
    expect(handler).toContain('ctx.chat.type === "private"');
    expect(handler).toContain("exitMenu(await exitPotsOf(u.address!)");
    expect(handler.indexOf("exitPotsOf")).toBeLessThan(handler.indexOf("potOf(ctx.chat.id)"));
  });

  test("the pots come from memberships in the database (active only, any letter case), not from Telegram", () => {
    const q = bot.slice(bot.indexOf("async function exitPotsOf"), bot.indexOf("async function burnLink"));
    expect(q).toContain("eq(schema.members.active, true)");
    expect(q).toContain("lower(${schema.members.address}) = ${address.toLowerCase()}");
    expect(q).toContain("innerJoin(schema.pots");
    expect(q).not.toContain("chatId");
  });

  test("in a group it works as before and tells members it also works in private", () => {
    expect(handler).toContain("`${EXIT_TEXT}\\n\\n${EXIT_IN_PRIVATE_NOTE}`");
    expect(handler).toContain('signerUrl(linkCtx(ctx), "exit", pot.address)');
    expect(EXIT_IN_PRIVATE_NOTE).toBe("You can also send /exit to me in a private chat, even if this group is gone.");
  });
});
