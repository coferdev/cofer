/**
 * Every bot command and button, run through the real bot (test/botHarness.ts): for each, the refusals
 * (no key, wrong chat, no group account, bad input, not allowed) and the normal case. Every message the
 * bot sends is also checked: only plain url buttons, never a Mini App, and personal links never shown
 * to a whole group.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { verifyLink } from "../src/core/linkToken";
import { Kind } from "../src/core/proposal";
import { CARDS_OFF_TEXT } from "../src/bot/help";
import { NOTICE_POINTER, NOTICE_TEXT, NOTICE_TITLE } from "../src/core/notice";
import { DEPOSITS_CLOSED_TEXT } from "../src/core/depositGate";
import { ONBOARD_DM_FIRST, ONBOARD_SENT_BY_DM, ONBOARD_TEXT } from "../src/bot/bot";
import { NEWPOT_ADMINS_ONLY_TEXT, NEWPOT_ANONYMOUS_TEXT, GROUP_ANONYMOUS_BOT_ID } from "../src/bot/newpotAdmin";
import { INVALID_HANDLE_TEXT, notMemberText } from "../src/bot/resolveHandle";
import { EXIT_IN_PRIVATE_NOTE, NO_POTS_TEXT } from "../src/bot/exitList";
import { RPC_ERROR_TEXT } from "../src/core/errors";
import {
  ALICE,
  BOB,
  GROUP,
  NEW_POT,
  POT,
  PROPOSAL_ID,
  TEST_ENV,
  TSLA,
  USDG,
  command,
  groupPot,
  lastMessage,
  linkedUser,
  listedTsla,
  makeBot,
  messages,
  privateChat,
  releaseHarness,
  resetState,
  state,
  tap,
  urls,
} from "./botHarness";

type Bot = Awaited<ReturnType<typeof makeBot>>;
let bot: Bot;
const send = (u: unknown) => bot.handleUpdate(u as never);
const say = (text: string, from = ALICE, chat: Parameters<typeof command>[2] = GROUP) => send(command(text, from, chat));
const text = () => String(lastMessage()?.text ?? "");
const claims = (url: string) => verifyLink(new URL(url).pathname.split("/s/")[1]!, TEST_ENV.LINK_SECRET);

beforeEach(async () => {
  resetState();
  bot = await makeBot();
});

// Checked after every test: what any command sent must respect the bot's rules.
afterEach(() => {
  try {
    checkSent();
  } finally {
    releaseHarness(); // always: the stand-ins are off between bot tests, so other test files see the real modules
  }
});

function checkSent() {
  for (const m of messages()) {
    const kb = (m.reply_markup as { inline_keyboard?: Record<string, unknown>[][] } | undefined)?.inline_keyboard ?? [];
    for (const b of kb.flat()) {
      expect(Object.keys(b).sort()).toEqual(["text", "url"]); // only url buttons: no web_app, login_url or callback here
      expect(String(b.url)).toStartWith(`${TEST_ENV.PUBLIC_URL}/s/`);
    }
    // a personal link in a group goes only as an ephemeral message (shown to one member)
    if (kb.length && Number(m.chat_id) < 0) expect(m.ephemeral_message_parameters).toBeDefined();
    // a sign-up link only ever goes to the member's private chat
    for (const u of urls(m)) if (claims(u).p === "onboard") expect(Number(m.chat_id)).toBeGreaterThan(0);
  }
  expect(state.sent.some((s) => s.method === "setChatMenuButton")).toBe(false);
}

/** The member was asked to set up a key (by private message), and nothing else happened. */
function expectOnboarding(user = ALICE) {
  const dm = messages().find((m) => Number(m.chat_id) === user.id);
  expect(dm?.text).toBe(ONBOARD_TEXT);
  const c = claims(urls(dm)[0]!);
  expect([c.p, c.tg, c.chat]).toEqual(["onboard", user.id, user.id]);
  expect(state.proposals).toHaveLength(0);
}

// ---------------------------------------------------------------- /start /chatid /region /help

describe("/start", () => {
  test("in a group: points to /newpot for admins, no link", async () => {
    await say("/start");
    expect(text()).toBe("Hi! A group admin can run /newpot to open a group account, or see /help.");
    expect(urls(lastMessage())).toEqual([]);
  });

  test("in the private chat: records the member and sends a sign-up link bound to them", async () => {
    await say("/start", ALICE, privateChat(ALICE));
    expect(state.users).toEqual([expect.objectContaining({ tgId: ALICE.id, username: ALICE.username })]);
    const c = claims(urls(lastMessage())[0]!);
    expect([c.p, c.tg, c.chat]).toEqual(["onboard", ALICE.id, ALICE.id]);
  });
});

describe("/start: the statement", () => {
  const startMessages = () => messages().map((m) => ({ text: String(m.text ?? ""), urls: urls(m), parseMode: m.parse_mode, entities: m.entities }));

  for (const [who, setup] of [
    ["a new member", () => {}],
    ["an already linked member", () => linkedUser(ALICE)],
  ] as const) {
    test(`${who}: the notice comes once, first, in plain text, above the set-up button`, async () => {
      setup();
      await say("/start", ALICE, privateChat(ALICE));
      const sent = startMessages();
      expect(sent).toHaveLength(2);
      expect(sent[0]!.text).toBe(NOTICE_TEXT);
      expect(sent[0]!.urls).toEqual([]); // the notice itself carries no button
      expect(sent[0]!.parseMode).toBeUndefined(); // plain text: no Markdown or HTML
      expect(sent[0]!.entities).toBeUndefined();
      expect(sent[1]!.urls).toHaveLength(1); // then the usual reply with "Set up my key"
      expect(claims(sent[1]!.urls[0]!).p).toBe("onboard");
      expect(sent.filter((m) => m.text.includes(NOTICE_TITLE))).toHaveLength(1);
    });
  }

  test("not in a group: the group reply is unchanged and has no notice", async () => {
    await say("/start");
    expect(messages()).toHaveLength(1);
    expect(text()).not.toContain(NOTICE_TITLE);
  });
});

describe("/chatid", () => {
  test("silent in a group", async () => {
    await say("/chatid");
    expect(state.sent).toHaveLength(0);
  });

  test("in the private chat: shows the chat id for OPS_CHAT_ID", async () => {
    await say("/chatid", ALICE, privateChat(ALICE));
    expect(text()).toContain(`OPS_CHAT_ID=${ALICE.id}`);
  });
});

describe("/region", () => {
  test("refuses anything but a two-letter code", async () => {
    for (const bad of ["/region", "/region usa", "/region 12", "/region d"]) {
      await say(bad);
      expect(text()).toBe("Usage: /region XX (two-letter country code)");
    }
  });

  test("saves a valid code, upper-cased", async () => {
    linkedUser(ALICE);
    await say("/region de");
    expect(text()).toBe("Saved: DE.");
    expect(state.users[0]!.region).toBe("DE");
  });
});

describe("/help", () => {
  test("lists the commands; /card only when cards are on", async () => {
    await say("/help");
    expect(text()).toContain("/exit take your exact share");
    expect(text()).not.toContain("/card");
    bot = await makeBot({ cardsOn: true });
    await say("/help");
    expect(text()).toContain("/card");
  });

  test("ends with the pointer to the statement, with cards on or off", async () => {
    for (const cardsOn of [false, true]) {
      bot = await makeBot({ cardsOn });
      await say("/help");
      expect(text().split("\n").at(-1)).toBe(NOTICE_POINTER);
      expect(NOTICE_POINTER).toBe("Read the statement: send /start to me in a private chat.");
    }
  });
});

// ---------------------------------------------------------------- /newpot

describe("/newpot", () => {
  test("refused in a private chat", async () => {
    await say("/newpot", ALICE, privateChat(ALICE));
    expect(text()).toBe("Add me to your group and run /newpot there.");
  });

  test("refused for a member who is not a group admin", async () => {
    linkedUser(ALICE);
    await say("/newpot");
    expect(text()).toBe(NEWPOT_ADMINS_ONLY_TEXT);
    expect(state.createPots).toHaveLength(0);
  });

  test("refused for an anonymous admin (posting as the group), with how to fix it", async () => {
    await send(command("/newpot", { id: GROUP_ANONYMOUS_BOT_ID, first_name: "Group", username: "GroupAnonymousBot" }, GROUP, GROUP));
    expect(text()).toBe(NEWPOT_ANONYMOUS_TEXT);
    expect(state.sent.some((s) => s.method === "getChatMember")).toBe(false);
  });

  test("an admin without a key is asked to set one up first", async () => {
    state.roles[ALICE.id] = "administrator";
    await say("/newpot");
    expectOnboarding();
    expect(messages().some((m) => m.text === ONBOARD_SENT_BY_DM)).toBe(true);
    expect(state.createPots).toHaveLength(0);
  });

  test("refused when the group already has an account", async () => {
    state.roles[ALICE.id] = "creator";
    linkedUser(ALICE);
    groupPot();
    await say("/newpot");
    expect(text()).toBe("This group already has an account. /pot to see it.");
    expect(state.createPots).toHaveLength(0);
  });

  test("refused by the per-user limit, before the relayer pays for anything", async () => {
    state.roles[ALICE.id] = "administrator";
    linkedUser(ALICE);
    state.rateWaitMs = 5 * 3600_000;
    await say("/newpot");
    expect(text()).toContain("You opened a group account recently");
    expect(state.createPots).toHaveLength(0);
  });

  test("an admin with a key opens the account: the relayer sends createPot with them as the only member", async () => {
    state.roles[ALICE.id] = "administrator";
    linkedUser(ALICE);
    await say("/newpot");
    expect(state.createPots).toHaveLength(1);
    const args = (state.createPots[0] as { args: unknown[] }).args;
    expect(args[0]).toEqual([ALICE.address]);
    expect(state.pots).toEqual([expect.objectContaining({ address: NEW_POT, chatId: GROUP.id, title: GROUP.title, creatorTg: ALICE.id })]);
    expect(text()).toContain(`Group account open: ${NEW_POT}`);
  });
});

// ---------------------------------------------------------------- commands that need a key and a pot

/** Commands that ask for a key first and refuse without a group account. */
const needsKeyAndPot = ["/deposit", "/claim", "/me", "/buy TSLA 100", "/sell TSLA all", "/spend"];

describe("every command that needs a key", () => {
  for (const cmd of [...needsKeyAndPot, "/join", "/exit", "/send 5 @bob_smith", "/allowance @bob_smith 5 week", "/plan 1"]) {
    test(`${cmd}: no key -> asked to set one up by private message, nothing proposed`, async () => {
      await say(cmd);
      expectOnboarding();
    });
  }

  test("no key and no private chat with the bot yet: told to open one, still no link in the group", async () => {
    state.dmBlocked.add(ALICE.id);
    await say("/deposit");
    expect(text()).toBe(ONBOARD_DM_FIRST);
  });
});

describe("every command that needs a group account", () => {
  for (const cmd of needsKeyAndPot) {
    test(`${cmd}: no group account -> refused`, async () => {
      linkedUser(ALICE);
      await say(cmd);
      expect(text()).toBe("No group account here yet.");
      expect(state.proposals).toHaveLength(0);
    });
  }

  for (const cmd of ["/join", "/plan 2"]) {
    test(`${cmd}: no group account -> refused, nothing proposed`, async () => {
      linkedUser(ALICE);
      await say(cmd);
      expect(text()).toBe("No group account here yet. An admin can run /newpot.");
      expect(state.proposals).toHaveLength(0);
    });
  }

  test("/pot: no group account -> refused", async () => {
    await say("/pot");
    expect(text()).toBe("No group account here yet.");
  });
});

// ---------------------------------------------------------------- personal links

describe("personal links (ephemeral, bound to the member and the pot)", () => {
  const cases: [string, string, string][] = [
    ["/deposit", "deposit", POT],
    ["/claim", "claim", POT],
    ["/exit", "exit", POT],
    ["/spend", "sign", `spend:${POT}`],
  ];
  for (const [cmd, purpose, ref] of cases) {
    test(`${cmd} -> one ${purpose} link for this member`, async () => {
      linkedUser(ALICE);
      groupPot();
      await say(cmd);
      const m = lastMessage()!;
      expect(m.ephemeral_message_parameters).toEqual({ receiver_user_id: ALICE.id });
      const c = claims(urls(m)[0]!);
      expect([c.p, c.ref, c.tg, c.chat]).toEqual([purpose, ref, ALICE.id, GROUP.id]);
    });
  }

  test("/exit in a group says it also works in private", async () => {
    linkedUser(ALICE);
    groupPot();
    await say("/exit");
    expect(text()).toContain(EXIT_IN_PRIVATE_NOTE);
  });

  test("/exit in the private chat lists the member's pots, even with no group", async () => {
    linkedUser(ALICE);
    groupPot();
    await say("/exit", ALICE, privateChat(ALICE));
    const c = claims(urls(lastMessage())[0]!);
    expect([c.p, c.ref, c.chat]).toEqual(["exit", POT, ALICE.id]);
  });

  test("/exit in the private chat, in no pot -> says so, no link", async () => {
    linkedUser(ALICE);
    await say("/exit", ALICE, privateChat(ALICE));
    expect(text()).toBe(NO_POTS_TEXT);
    expect(urls(lastMessage())).toEqual([]);
  });
});

describe("/deposit refusals before any link", () => {
  test("a held stock's price is over 12 hours old -> deposits closed, no link", async () => {
    linkedUser(ALICE);
    groupPot();
    state.chain.held = [USDG, TSLA];
    state.chain.distributable[TSLA.toLowerCase()] = 10n ** 18n;
    state.chain.priceUpdatedAt[TSLA.toLowerCase()] = state.chain.now - 13 * 3600;
    await say("/deposit");
    expect(text()).toBe(DEPOSITS_CLOSED_TEXT);
    expect(urls(lastMessage())).toEqual([]);
  });

  test("the group is at the beta limit -> refused, no link", async () => {
    linkedUser(ALICE);
    groupPot();
    state.chain.nav = 5_000_000_000n;
    await say("/deposit");
    expect(text()).toContain("reached the 5,000 USDG beta limit");
    expect(urls(lastMessage())).toEqual([]);
  });
});

describe("/me", () => {
  test("shows the member's share and allowance", async () => {
    linkedUser(ALICE);
    groupPot();
    await say("/me");
    expect(text()).toBe("Your share: 50% of the pot.\nAllowance left: 0 USDG.");
  });

  test("a chain error is reported as fixed text, never with the RPC address", async () => {
    linkedUser(ALICE);
    groupPot();
    state.chain.fail = true;
    await say("/me");
    expect(text()).not.toMatch(/https?:|SECRET/);
    expect(text().length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------- votes

describe("/buy", () => {
  const ready = () => {
    linkedUser(ALICE);
    groupPot();
    listedTsla();
  };

  test("bad input is refused with the usage or the reason", async () => {
    ready();
    for (const [cmd, want] of [
      ["/buy", "usage: /buy SYMBOL AMOUNT_USDG"],
      ["/buy T_LA 100", "usage: /buy SYMBOL AMOUNT_USDG"], // "_" is not a symbol character
      ["/buy TSLA", "amount missing"],
      ["/buy TSLA abc", 'bad amount "abc"'],
      ["/buy TSLA 0", "amount must be > 0"],
    ]) {
      await say(cmd!);
      expect(text()).toBe(want!);
    }
    expect(state.proposals).toHaveLength(0);
  });

  test("a stock that is not listed is refused", async () => {
    ready();
    await say("/buy AAPL 100");
    expect(text()).toBe("AAPL isn't on the list.");
  });

  test("new buys are paused during a corporate action", async () => {
    linkedUser(ALICE);
    groupPot();
    listedTsla({ pendingMultiplier: "2000000000000000000", pendingEffectiveAt: new Date((state.chain.now + 86_400) * 1000) });
    await say("/buy TSLA 100");
    expect(text()).toContain("New buys of TSLA are paused");
    expect(state.proposals).toHaveLength(0);
  });

  test("a valid buy proposes a swap through the allowed adapter, with a minimum out under the oracle price", async () => {
    ready();
    await say("/buy tsla 100");
    expect(state.proposals).toHaveLength(1);
    const a = state.proposals[0]!.action as { kind: number; adapter: string; tokenIn: string; tokenOut: string; amountIn: bigint; minOut: bigint };
    expect(a.kind).toBe(Kind.SWAP);
    expect([a.adapter, a.tokenIn, a.tokenOut, a.amountIn]).toEqual([TEST_ENV.ADAPTER_ADDRESS, USDG, TSLA, 100_000_000n]);
    const oracleOut = (99_700_000n * 10n ** 12n) / 250n; // after the 0.30% fee, at 250 USDG per TSLA
    expect(a.minOut > 0n && a.minOut < oracleOut).toBe(true);
    const c = claims(urls(lastMessage())[0]!);
    expect([c.p, c.ref]).toEqual(["sign", PROPOSAL_ID]);
  });

  test("the chain cannot be read: fixed text, nothing proposed", async () => {
    ready();
    state.chain.fail = true;
    await say("/buy TSLA 100");
    expect(text()).toBe(RPC_ERROR_TEXT);
    expect(state.proposals).toHaveLength(0);
  });
});

describe("/sell", () => {
  test("bad input and unknown stocks are refused", async () => {
    linkedUser(ALICE);
    groupPot();
    listedTsla();
    await say("/sell");
    expect(text()).toBe("usage: /sell SYMBOL PERCENT|all [slip=0.5]");
    await say("/sell NVDA all");
    expect(text()).toBe("NVDA isn't on the list.");
  });

  test("nothing to sell -> refused", async () => {
    linkedUser(ALICE);
    groupPot();
    listedTsla();
    await say("/sell TSLA all");
    expect(text()).toBe("The group holds no TSLA.");
  });

  test("a valid sell proposes a swap of that share of the holding back to USDG", async () => {
    linkedUser(ALICE);
    groupPot();
    listedTsla();
    state.chain.distributable[TSLA.toLowerCase()] = 4n * 10n ** 18n;
    await say("/sell TSLA 50%");
    const a = state.proposals[0]!.action as { kind: number; tokenIn: string; tokenOut: string; amountIn: bigint };
    expect([a.kind, a.tokenIn, a.tokenOut, a.amountIn]).toEqual([Kind.SWAP, TSLA, USDG, 2n * 10n ** 18n]);
  });
});

describe("/send", () => {
  test("bad amount, bad username, and a name that is not a member of this group are refused", async () => {
    linkedUser(ALICE);
    groupPot();
    await say("/send");
    expect(text()).toBe("usage: /send AMOUNT @member|0xaddress");
    await say("/send ten @bob_smith");
    expect(text()).toBe('bad amount "ten"');
    await say("/send 10 @b%");
    expect(text()).toBe(INVALID_HANDLE_TEXT);
    await say("/send 10 @bob_smith");
    expect(text()).toBe(notMemberText("bob_smith"));
    expect(state.proposals).toHaveLength(0);
  });

  test("a look-alike username is never chosen (audit v2 M-1)", async () => {
    linkedUser(ALICE);
    state.users.push({ tgId: 666, username: "bobxsmith", address: "0x000000000000000000000000000000000bAD0bAD" });
    groupPot([ALICE.address, "0x000000000000000000000000000000000bAD0bAD"]);
    await say("/send 10 @bob_smith");
    expect(text()).toBe(notMemberText("bob_smith"));
    expect(state.proposals).toHaveLength(0);
  });

  test("to a member by username, or to any 0x address: proposes a USDG transfer", async () => {
    linkedUser(ALICE);
    linkedUser(BOB);
    groupPot([ALICE.address, BOB.address]);
    await say("/send 10 @Bob_Smith");
    await say(`/send 2.5 ${BOB.address.toLowerCase()}`);
    expect(state.proposals.map((p) => p.action)).toEqual([
      { kind: Kind.TRANSFER, asset: USDG, to: BOB.address, amount: 10_000_000n },
      { kind: Kind.TRANSFER, asset: USDG, to: BOB.address, amount: 2_500_000n },
    ]);
  });

  test("outside a group (no pot): a username cannot be looked up", async () => {
    linkedUser(ALICE);
    await say("/send 10 @bob_smith", ALICE, privateChat(ALICE));
    expect(text()).toBe("No group account here yet. An admin can run /newpot.");
  });
});

describe("/allowance", () => {
  test("missing member, bad amount and bad period are refused", async () => {
    linkedUser(ALICE);
    groupPot();
    await say("/allowance");
    expect(text()).toBe("usage: /allowance @member AMOUNT [day|week|month]");
    await say("/allowance @bob_smith lots week");
    expect(text()).toBe('bad amount "lots"');
    await say("/allowance @bob_smith 5 fortnight");
    expect(text()).toContain("fortnight");
    expect(state.proposals).toHaveLength(0);
  });

  test("a valid allowance for a member is proposed; 'off' turns it off", async () => {
    linkedUser(ALICE);
    linkedUser(BOB);
    groupPot([ALICE.address, BOB.address]);
    await say("/allowance @bob_smith 50 week");
    await say("/allowance @bob_smith off");
    expect(state.proposals.map((p) => p.action)).toEqual([
      { kind: Kind.SET_ALLOWANCE, member: BOB.address, amount: 50_000_000n, period: 7 * 86_400 },
      { kind: Kind.SET_ALLOWANCE, member: BOB.address, amount: 0n, period: 0 },
    ]);
  });
});

describe("/join", () => {
  test("proposes adding the member's own key", async () => {
    linkedUser(BOB);
    groupPot();
    await say("/join", BOB);
    expect(state.proposals).toEqual([{ pot: POT, action: { kind: Kind.ADD_MEMBER, member: BOB.address }, proposerTg: BOB.id }]);
  });
});

describe("/plan", () => {
  test("months outside 1-12 are refused", async () => {
    linkedUser(ALICE);
    groupPot();
    for (const bad of ["/plan 0", "/plan 13", "/plan two", "/plan 1.5"]) {
      await say(bad);
      expect(text()).toBe("Usage: /plan MONTHS (1-12)");
    }
    expect(state.proposals).toHaveLength(0);
  });

  test("a plan vote carries today's price x months as its maximum cost", async () => {
    linkedUser(ALICE);
    groupPot();
    await say("/plan 3");
    expect(state.proposals[0]!.action).toEqual({ kind: Kind.PAY_PLAN, months: 3, maxCost: 27_000_000n });
  });

  test("the price cannot be read: fixed text, nothing proposed", async () => {
    linkedUser(ALICE);
    groupPot();
    state.chain.fail = true;
    await say("/plan 3");
    expect(text()).toBe(RPC_ERROR_TEXT);
    expect(state.proposals).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- /card /pot

describe("/card", () => {
  test("cards off: refused before anything else", async () => {
    await say("/card");
    expect(text()).toBe(CARDS_OFF_TEXT);
  });

  test("cards on: needs a key and a pot, then sends a card link", async () => {
    bot = await makeBot({ cardsOn: true });
    await say("/card");
    expectOnboarding();
    resetState();
    bot = await makeBot({ cardsOn: true });
    linkedUser(ALICE);
    await say("/card");
    expect(text()).toBe("No group account here yet.");
    groupPot();
    await say("/card");
    expect(claims(urls(lastMessage())[0]!).p).toBe("card");
  });
});

describe("/pot", () => {
  test("lists the holdings, needs no key", async () => {
    groupPot();
    state.holdings.push({ pot: POT, asset: USDG, rawBalance: "1000000000", reserved: "0", valueUsdg: "1000000000" });
    await say("/pot", BOB);
    expect(text()).toBe(`Group account ${POT}\nUSDG: 1000 (1000 USDG)`);
  });
});

// ---------------------------------------------------------------- vote card buttons

describe("vote card buttons", () => {
  test("Approve without a key: the tap is answered and the member is asked to set up a key", async () => {
    await send(tap(`sign:${PROPOSAL_ID}`, BOB));
    expect(state.sent.some((s) => s.method === "answerCallbackQuery")).toBe(true);
    expectOnboarding(BOB);
  });

  test("Approve with a key: a sign link for that vote, only for the member who tapped", async () => {
    linkedUser(BOB);
    await send(tap(`sign:${PROPOSAL_ID}`, BOB));
    const m = lastMessage()!;
    expect(m.ephemeral_message_parameters).toEqual(expect.objectContaining({ receiver_user_id: BOB.id }));
    const c = claims(urls(m)[0]!);
    expect([c.p, c.ref, c.tg]).toEqual(["sign", PROPOSAL_ID, BOB.id]);
  });

  test("Details: the vote's summary and tally, no link", async () => {
    await send(tap(`info:${PROPOSAL_ID}`, BOB));
    expect(text()).toBe("Send 50 USDG to @bob_smith\nStatus: collecting\nSigned by 1 of 2 needed.");
    expect(urls(lastMessage())).toEqual([]);
  });

  test("a button with malformed data does nothing", async () => {
    await send(tap("sign:not-a-proposal", BOB));
    await send(tap(`info:${PROPOSAL_ID}ff`, BOB));
    expect(messages()).toHaveLength(0);
  });
});
