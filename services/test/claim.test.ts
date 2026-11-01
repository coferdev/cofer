import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { signerUrl } from "../src/bot/keyboards";
import { helpText } from "../src/bot/help";
import { verifyLink } from "../src/core/linkToken";

const SRC = join(import.meta.dir, "..", "src");
const read = (...p: string[]) => readFileSync(join(SRC, ...p), "utf8");
const bot = read("bot", "bot.ts");
const client = read("web", "client.ts");
const command = (name: string) => {
  const start = bot.indexOf(`bot.command(${name}`);
  return bot.slice(start, bot.indexOf("bot.command(", start + 1));
};

describe("/claim gets a set-aside token, never an exit", () => {
  test("/claim opens a claim link; /exit opens the exit link; they are separate commands", () => {
    expect(bot).not.toContain('bot.command(["exit", "claim"]');
    const claim = command('"claim"');
    expect(claim).toContain('signerUrl(linkCtx(ctx), "claim", pot.address)');
    expect(claim).not.toContain('"exit"');
    expect(command('"exit"')).toContain('signerUrl(linkCtx(ctx), "exit", pot.address)');
  });

  test("a claim link carries the claim purpose", () => {
    const secret = "x".repeat(40);
    const url = signerUrl({ publicUrl: "https://sign.example", secret, tgId: 7, chatId: -100 }, "claim", "0x00000000000000000000000000000000000c0FFE");
    const claims = verifyLink(url.split("/s/")[1]!, secret);
    expect(claims).toMatchObject({ p: "claim", ref: "0x00000000000000000000000000000000000c0FFE", tg: 7 });
  });

  test("the signer page's claim section calls claimOwed for the member's own address, and never exit", () => {
    const start = client.indexOf('} else if (ex.purpose === "claim") {');
    expect(start).toBeGreaterThan(-1);
    const section = client.slice(start, client.indexOf("} else if (", start + 10));
    expect(section).toContain('functionName: "owed", args: [a, s.address]');
    expect(section).toContain('functionName: "claimOwed", args: [a, s.address]');
    expect(section).not.toMatch(/functionName: "(exit|leave|deposit|spend)"/);
    expect(section).toContain('throw new Stop("Nothing is set aside for you in this group.")');
    expect(section.indexOf("await memberSigner()")).toBeLessThan(section.indexOf("claimOwed"));
  });

  test("one claim per token, so a paused token does not block the others", () => {
    const section = client.slice(client.indexOf('} else if (ex.purpose === "claim") {'));
    expect(section).toMatch(/for \(const a of owed\) \{[\s\S]*?try \{[\s\S]*?claimOwed[\s\S]*?\} catch \(e\) \{\s*firstError \?\?= e;/);
  });

  test("the exit notice that sends members to /claim now points at the right thing", () => {
    expect(read("indexer", "indexer.ts")).toContain("can be claimed any time with /claim.");
  });
});

describe("/help", () => {
  test("lists /claim and /plan", () => {
    // the text lives in bot/help.ts; the /help command replies with it
    expect(command('"help"')).toContain("helpText(");
    for (const cardsOn of [false, true]) {
      const help = helpText({ cardsOn });
      expect(help).toContain("/claim get a token set aside for you during an exit");
      expect(help).toContain("/plan 3 vote to prepay the optional group plan for 3 months");
    }
  });
});
