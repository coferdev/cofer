/**
 * The private "Open dashboard" button on /me and /pot (no new command). It is a one-time
 * "dashboard" link made for the member's own private chat, sent only to that member (ephemeral in a
 * group, else a DM), never on the group's /pot reply, and only when DASHBOARD_URL is set.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { verifyLink } from "../src/core/linkToken";
import { DASHBOARD_TEXT } from "../src/bot/bot";
import { DASHBOARD_LINK_TTL_SEC } from "../src/dashboard/routes";
import { ALICE, BOB, GROUP, POT, TEST_ENV, USDG, command, groupPot, linkedUser, makeBot, messages, privateChat, releaseHarness, resetState, state, urls } from "./botHarness";

type Bot = Awaited<ReturnType<typeof makeBot>>;
let bot: Bot;
const DASH = "https://testdashboard.test";
const say = (text: string, from = ALICE, chat: Parameters<typeof command>[2] = GROUP) => bot.handleUpdate(command(text, from, chat) as never);
const dashClaims = (url: string) => verifyLink(new URL(url).hash.replace(/^#t=/, ""), TEST_ENV.LINK_SECRET);
const dashMessages = () => messages().filter((m) => urls(m).some((u) => u.startsWith(`${DASH}/`)));

beforeEach(async () => {
  resetState();
  (TEST_ENV as { DASHBOARD_URL?: string }).DASHBOARD_URL = DASH;
  bot = await makeBot();
});

afterEach(() => {
  delete (TEST_ENV as { DASHBOARD_URL?: string }).DASHBOARD_URL;
  // whatever was sent: a dashboard link only ever goes to one member, never to a whole group
  for (const m of dashMessages()) {
    if (Number(m.chat_id) < 0) expect(m.ephemeral_message_parameters).toBeDefined();
    const kb = (m.reply_markup as { inline_keyboard: Record<string, unknown>[][] }).inline_keyboard.flat();
    for (const b of kb) expect(Object.keys(b).sort()).toEqual(["text", "url"]); // a url button only: no Mini App
  }
  releaseHarness();
});

function expectDashboardLink(m: Record<string, unknown> | undefined, who: typeof ALICE) {
  const [url, ...rest] = urls(m);
  expect(rest).toEqual([]);
  expect(url).toStartWith(`${DASH}/#t=`);
  const c = dashClaims(url!);
  expect([c.p, c.tg, c.chat, c.ref]).toEqual(["dashboard", who.id, who.id, ""]);
  const now = Math.floor(Date.now() / 1000);
  expect(c.exp).toBeLessThanOrEqual(now + DASHBOARD_LINK_TTL_SEC + 1);
  expect(c.exp).toBeGreaterThan(now);
  const kb = (m!.reply_markup as { inline_keyboard: { text: string }[][] }).inline_keyboard.flat();
  expect(kb.map((b) => b.text)).toEqual(["Open dashboard"]);
  return c;
}

describe("/me", () => {
  test("in a group: the share reply carries the private dashboard button, only for that member", async () => {
    linkedUser(ALICE);
    groupPot();
    await say("/me");
    const m = messages().at(-1)!;
    expect(String(m.text)).toStartWith("Your share:");
    expect(m.ephemeral_message_parameters).toEqual(expect.objectContaining({ receiver_user_id: ALICE.id }));
    expectDashboardLink(m, ALICE);
  });

  test("in the private chat: no pot there, but the dashboard button for all the member's pots", async () => {
    linkedUser(ALICE);
    groupPot();
    await say("/me", ALICE, privateChat(ALICE));
    const m = messages().at(-1)!;
    expect(m.text).toBe(DASHBOARD_TEXT);
    expect(Number(m.chat_id)).toBe(ALICE.id);
    expectDashboardLink(m, ALICE);
  });

  test("each tap makes a new one-time link", async () => {
    linkedUser(ALICE);
    groupPot();
    await say("/me");
    await say("/me");
    const [a, b] = dashMessages().map((m) => dashClaims(urls(m)[0]!).jti);
    expect(a).not.toBe(b);
  });

  test("DASHBOARD_URL unset: no button, the reply is as before", async () => {
    delete (TEST_ENV as { DASHBOARD_URL?: string }).DASHBOARD_URL;
    linkedUser(ALICE);
    groupPot();
    await say("/me");
    expect(urls(messages().at(-1))).toEqual([]);
    await say("/me", ALICE, privateChat(ALICE));
    expect(messages().at(-1)!.text).toBe("No group account here yet.");
  });
});

describe("/pot", () => {
  test("the group reply has no link; the member gets the dashboard button privately", async () => {
    linkedUser(ALICE);
    groupPot();
    state.holdings.push({ pot: POT, asset: USDG, rawBalance: "1000000000", reserved: "0", valueUsdg: "1000000000" });
    await say("/pot");
    const [groupReply, personal] = messages();
    expect(groupReply!.text).toBe(`Group account ${POT}\nUSDG: 1000 (1000 USDG)`);
    expect(urls(groupReply)).toEqual([]);
    expect(groupReply!.ephemeral_message_parameters).toBeUndefined();
    expect(personal!.text).toBe(DASHBOARD_TEXT);
    expect(personal!.ephemeral_message_parameters).toEqual(expect.objectContaining({ receiver_user_id: ALICE.id }));
    expectDashboardLink(personal, ALICE);
  });

  test("someone who is not a member of this pot, or has no key, gets no dashboard button", async () => {
    groupPot([ALICE.address]);
    linkedUser(BOB); // has a key, not a member here
    await say("/pot", BOB);
    expect(dashMessages()).toEqual([]);
    resetState();
    groupPot([ALICE.address]);
    await say("/pot", ALICE); // a member's address, but no key bound to this Telegram account
    expect(dashMessages()).toEqual([]);
  });
});
