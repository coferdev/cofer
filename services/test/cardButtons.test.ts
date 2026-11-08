/**
 * Vote card buttons must fit Telegram's 64-byte callback_data limit. On testnet the card for the
 * first proposal was refused with BUTTON_DATA_INVALID because each button carried "sign:" / "info:"
 * plus the full 0x + 64 hex id (71 bytes), so no card was ever posted. These tests use real-length
 * ids, the id from that failure, and the strict Telegram stand-in (strictTelegram.ts).
 */
import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { InlineKeyboard } from "grammy";
import { decodeProposalRef, encodeProposalRef, proposalCard } from "../src/bot/keyboards";
import { renderCard, updateCard, type CardDeps } from "../src/notifier/notifier";
import { CALLBACK_DATA_MAX_BYTES, TEXT_MAX_CHARS, enforceTelegramLimits, telegramProblem } from "./strictTelegram";

/** The proposal whose card Telegram refused on testnet. */
const TESTNET_ID = "0xaa4ffd313976d19f4a03bd07e0bfb2a552a42dbefcdac58c20703bfe6af3f3fc";
const randomId = () => `0x${randomBytes(32).toString("hex")}`;
const callbackData = (kb: InlineKeyboard) => kb.inline_keyboard.flat().map((b) => (b as { callback_data?: string }).callback_data!);

describe("vote card buttons fit Telegram's limit", () => {
  test("every button of the card for the testnet proposal is within 64 bytes and accepted", () => {
    const kb = proposalCard(TESTNET_ID);
    const data = callbackData(kb);
    expect(data).toHaveLength(2);
    for (const d of data) expect(Buffer.byteLength(d, "utf8")).toBe(48);
    expect(telegramProblem("sendMessage", { chat_id: -100, text: "Vote: x", reply_markup: kb })).toBeNull();
  });

  test("the old button form is exactly what Telegram refused (71 bytes)", () => {
    const old = new InlineKeyboard().text("Approve / review", `sign:${TESTNET_ID}`).text("Details", `info:${TESTNET_ID}`);
    expect(Buffer.byteLength(`sign:${TESTNET_ID}`, "utf8")).toBe(71);
    expect(telegramProblem("sendMessage", { chat_id: -100, text: "Vote: x", reply_markup: old })).toContain("BUTTON_DATA_INVALID");
  });

  test("for 1,000 random ids, every button is within 64 bytes", () => {
    for (let i = 0; i < 1_000; i++) {
      for (const d of callbackData(proposalCard(randomId()))) expect(Buffer.byteLength(d, "utf8")).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
    }
  });

  test("the notifier posts the testnet proposal's card through the strict stand-in", async () => {
    let posted = 0;
    const d: CardDeps = {
      withLock: (_id, fn) => fn(),
      load: async () => ({ chatId: -1001, messageId: null, text: "Vote: Add B as a member\nApprovals: 1/2", open: true }),
      send: async (chatId, text, kb) => {
        enforceTelegramLimits("sendMessage", { chat_id: chatId, text, reply_markup: kb });
        return ++posted;
      },
      edit: async () => {},
      saveMessageId: async () => {},
    };
    expect(await updateCard(TESTNET_ID, d)).toBe("posted");
    expect(posted).toBe(1);
  });
  test("the card goes from open to passed-and-waiting to done through the strict stand-in (send and edit)", async () => {
    const eta = Date.UTC(2026, 10, 8, 11, 6) / 1000;
    const base = { summary: "Send 100 USDG to @bob", approvals: 3, required: 3, delaySeconds: 21600, exitWindowSec: 21600 };
    const texts = [renderCard({ ...base, status: "collecting" }), renderCard({ ...base, status: "queued", queuedEta: eta }), renderCard({ ...base, status: "executed" })];
    expect(texts[1]).toBe("Vote: Send 100 USDG to @bob\nApprovals: 3/3\nPassed. It will be done in 6 hours, at 11:06 UTC on 8 Nov 2026. Disagree? /exit takes your exact share any time.");
    expect(texts[2]).toBe("Vote: Send 100 USDG to @bob\nApprovals: 3/3\nDone.");
    let step = 0;
    let messageId: number | null = null;
    const calls: string[] = [];
    const d: CardDeps = {
      withLock: (_id, fn) => fn(),
      load: async () => ({ chatId: -1001, messageId, text: texts[step]!, open: step === 0 }),
      send: async (chatId, text, kb) => {
        enforceTelegramLimits("sendMessage", { chat_id: chatId, text, reply_markup: kb });
        calls.push(`send:${text}`);
        return 7;
      },
      edit: async (chatId, id, text, kb) => {
        enforceTelegramLimits("editMessageText", { chat_id: chatId, message_id: id, text, reply_markup: kb });
        calls.push(`edit:${text}`);
      },
      saveMessageId: async (_id, m) => void (messageId = m),
    };
    expect(await updateCard(TESTNET_ID, d)).toBe("posted");
    step = 1;
    expect(await updateCard(TESTNET_ID, d)).toBe("edited");
    step = 2;
    expect(await updateCard(TESTNET_ID, d)).toBe("edited");
    expect(calls).toEqual([`send:${texts[0]}`, `edit:${texts[1]}`, `edit:${texts[2]}`]);
  });
});

describe("proposal reference: encode and decode", () => {
  test("decode(encode(id)) is the original id, for 1,000 random ids", () => {
    for (let i = 0; i < 1_000; i++) {
      const id = randomId();
      const ref = encodeProposalRef(id);
      expect(ref).toHaveLength(43);
      expect(decodeProposalRef(ref)).toBe(id as `0x${string}`);
    }
    expect(decodeProposalRef(encodeProposalRef(TESTNET_ID))).toBe(TESTNET_ID);
  });

  test("an upper-case id gives the same reference and decodes to lower case", () => {
    const upper = `0x${TESTNET_ID.slice(2).toUpperCase()}`;
    expect(encodeProposalRef(upper)).toBe(encodeProposalRef(TESTNET_ID));
    expect(decodeProposalRef(encodeProposalRef(upper))).toBe(TESTNET_ID);
  });

  test("the encoder refuses anything that is not 0x + 64 hex", () => {
    for (const bad of ["", "0x", TESTNET_ID.slice(2), `${TESTNET_ID}00`, TESTNET_ID.slice(0, -1), `0x${"g".repeat(64)}`, ` ${TESTNET_ID}`, "0X" + TESTNET_ID.slice(2)]) {
      expect(() => encodeProposalRef(bad)).toThrow();
    }
  });

  test("the decoder refuses malformed or wrong-length references", () => {
    const ref = encodeProposalRef(TESTNET_ID);
    const bad = [
      "",
      ref.slice(0, -1), // 42 characters
      `${ref}A`, // 44 characters
      `${ref}=`, // padding
      TESTNET_ID, // the hex id itself
      TESTNET_ID.slice(2),
      ref.slice(0, -1) + "+", // standard base64, not base64url
      ref.slice(0, -1) + "/",
      ref.slice(0, 20) + " " + ref.slice(21), // a space
      ref.slice(0, -1) + "é",
      "A".repeat(42) + "B", // spare bits set: not the one canonical form of any id
      "_".repeat(43),
    ];
    for (const b of bad) expect(decodeProposalRef(b)).toBeNull();
  });

  test("of the 64 possible last characters, only the 16 canonical ones decode", () => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const head = encodeProposalRef(TESTNET_ID).slice(0, -1);
    const ok = [...alphabet].filter((c) => decodeProposalRef(head + c) !== null);
    expect(ok).toHaveLength(16);
    for (const c of ok) expect(encodeProposalRef(decodeProposalRef(head + c)!)).toBe(head + c);
  });
});

describe("the strict Telegram stand-in enforces Telegram's limits", () => {
  const kb = (b: Record<string, unknown>) => ({ inline_keyboard: [[{ text: "x", ...b }]] });

  test("callback_data: 64 bytes pass, 65 fail, counted in bytes", () => {
    expect(telegramProblem("sendMessage", { text: "t", reply_markup: kb({ callback_data: "a".repeat(64) }) })).toBeNull();
    expect(telegramProblem("sendMessage", { text: "t", reply_markup: kb({ callback_data: "a".repeat(65) }) })).toContain("BUTTON_DATA_INVALID");
    expect(telegramProblem("sendMessage", { text: "t", reply_markup: kb({ callback_data: "é".repeat(33) }) })).toContain("BUTTON_DATA_INVALID"); // 66 bytes
    expect(telegramProblem("sendMessage", { text: "t", reply_markup: kb({ callback_data: "" }) })).toContain("BUTTON_DATA_INVALID");
  });

  test("message text: 4096 characters pass, 4097 and empty fail, on send and edit", () => {
    for (const m of ["sendMessage", "editMessageText"]) {
      expect(telegramProblem(m, { text: "a".repeat(TEXT_MAX_CHARS) })).toBeNull();
      expect(telegramProblem(m, { text: "a".repeat(TEXT_MAX_CHARS + 1) })).toContain("too long");
      expect(telegramProblem(m, { text: "" })).toContain("empty");
    }
  });

  test("url buttons need a valid https url", () => {
    expect(telegramProblem("sendMessage", { text: "t", reply_markup: kb({ url: "https://sign.test/s/abc" }) })).toBeNull();
    for (const url of ["http://sign.test/s/abc", "not a url", "https://sign.test/s/a b", "", "javascript:alert(1)", "tg://resolve?domain=x"]) {
      expect(telegramProblem("sendMessage", { text: "t", reply_markup: kb({ url }) })).toBe("Bad Request: BUTTON_URL_INVALID");
    }
  });

  test("a refused call throws the same 400 error Telegram gives", () => {
    expect(() => enforceTelegramLimits("sendMessage", { text: "t", reply_markup: kb({ callback_data: "a".repeat(65) }) })).toThrow(/400: Bad Request: BUTTON_DATA_INVALID/);
  });
});
