import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TRPCError } from "@trpc/server";
import { appRouter, type ApiCtx } from "../src/api/router";
import { ONBOARD_DM_ONLY, onboardLinkProblem, signLink } from "../src/core/linkToken";
import { memoryStore } from "../src/bot/rateLimit";
import { NEWPOT_LIMIT, newPotRefusal } from "../src/bot/newpotLimit";

const secret = "s".repeat(40);
const TG = 7;
const GROUP = -100;
const now = () => Math.floor(Date.now() / 1000);
const onboard = (chat: number) => signLink({ tg: TG, chat, p: "onboard", ref: "", exp: now() + 900, jti: `j${chat}` }, secret);

function caller() {
  const writes: unknown[] = [];
  const db = {
    query: {
      linkTokens: { findFirst: async () => undefined },
      users: { findFirst: async () => undefined },
    },
    insert: () => ({
      values: (v: unknown) => ({
        onConflictDoUpdate: () => ({
          returning: async () => {
            writes.push(v);
            return [{ jti: "x" }];
          },
        }),
      }),
    }),
  };
  const ctx: ApiCtx = { deps: { db } as unknown as ApiCtx["deps"], cards: null, secret, session: null };
  return { api: appRouter.createCaller(ctx), writes };
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof TRPCError ? `${e.code}: ${e.message}` : String(e);
  }
}

describe("onboarding links are DM-only (leaked-link lead)", () => {
  test("the rule: an onboarding link must be made for the member's own private chat", () => {
    expect(onboardLinkProblem({ p: "onboard", tg: TG, chat: GROUP })).toBe(ONBOARD_DM_ONLY);
    expect(onboardLinkProblem({ p: "onboard", tg: TG, chat: TG })).toBeNull();
    expect(onboardLinkProblem({ p: "deposit", tg: TG, chat: GROUP })).toBeNull(); // other links may come from a group
  });

  test("the signer API refuses a group onboarding link for both preview and exchange, and writes nothing", async () => {
    const { api, writes } = caller();
    expect(await refusal(api.session.preview({ token: onboard(GROUP) }))).toBe(`UNAUTHORIZED: ${ONBOARD_DM_ONLY}`);
    expect(await refusal(api.session.exchange({ token: onboard(GROUP) }))).toBe(`UNAUTHORIZED: ${ONBOARD_DM_ONLY}`);
    expect(writes).toHaveLength(0);
  });

  test("a DM onboarding link still works", async () => {
    const { api, writes } = caller();
    expect(await refusal(api.session.preview({ token: onboard(TG) }))).toBe("ok");
    expect(await refusal(api.session.exchange({ token: onboard(TG) }))).toBe("ok");
    expect(writes).toHaveLength(1);
  });

  test("the bot sends onboarding links only by DM, never through the group reply path", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "bot", "bot.ts"), "utf8");
    // every onboarding link is made for the member's private chat
    const onboardLinks = src.match(/signerUrl\([^)]*\), "onboard"\)/g) ?? [];
    expect(onboardLinks.length).toBeGreaterThan(0);
    for (const l of onboardLinks) expect(l).toBe('signerUrl(onboardLinkCtx(ctx), "onboard")');
    const fn = /async function sendOnboardingLink\(ctx: Context\) \{([\s\S]*?)\n\}/.exec(src)![1]!;
    expect(fn).toContain("ctx.api.sendMessage(ctx.from!.id, ONBOARD_TEXT, { reply_markup: kb })");
    expect(fn).toContain("await ctx.reply(ONBOARD_DM_FIRST);");
    expect(fn).toContain("await ephemeral(ctx, ONBOARD_SENT_BY_DM);"); // no link argument
    const req = /async function requireLinked\(ctx: Context\) \{([\s\S]*?)\n\}/.exec(src)![1]!;
    expect(req).not.toContain("ephemeral(");
    expect(req).toContain("await sendOnboardingLink(ctx);");
  });
});

describe("/newpot per-user limit (I-7)", () => {
  const H = 3600_000;

  test("two pots per user per day, then a fixed refusal with the hours left", async () => {
    const store = memoryStore();
    const t0 = 1_000_000_000;
    expect(await newPotRefusal(store, TG, t0)).toBeNull();
    expect(await newPotRefusal(store, TG, t0 + H)).toBeNull();
    expect(await newPotRefusal(store, TG, t0 + 2 * H)).toBe("You opened a group account recently. Try again in about 22 hours.");
    expect(await newPotRefusal(store, TG, t0 + NEWPOT_LIMIT.windowMs - 30 * 60_000)).toBe("You opened a group account recently. Try again in about 1 hour.");
    expect(await newPotRefusal(store, TG, t0 + NEWPOT_LIMIT.windowMs + 1)).toBeNull(); // the first slot freed
  });

  test("the limit is per user", async () => {
    const store = memoryStore();
    const t0 = 1_000_000_000;
    await newPotRefusal(store, TG, t0);
    await newPotRefusal(store, TG, t0);
    expect(await newPotRefusal(store, TG, t0)).not.toBeNull();
    expect(await newPotRefusal(store, 8, t0)).toBeNull();
  });

  test("/newpot takes the slot before the relayer sends anything", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "bot", "bot.ts"), "utf8");
    const cmd = src.slice(src.indexOf('bot.command("newpot"'));
    expect(cmd.indexOf("newPotRefusal(rateStore, ctx.from!.id)")).toBeGreaterThan(0);
    expect(cmd.indexOf("newPotRefusal(")).toBeLessThan(cmd.indexOf("relayerClient()"));
  });
});
