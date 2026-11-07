/**
 * Telegram's own limits, checked in tests the way Telegram checks them, so a message or button it
 * would refuse fails here instead of on the server. Used by the bot harness (botHarness.ts) and the
 * card tests (cards.test.ts).
 *  - message text: 1 to 4096 characters (counted in UTF-16 units, which is never less than Telegram's count)
 *  - callback_data: 1 to 64 bytes (UTF-8)
 *  - url buttons: a valid https url, no spaces
 */
import { GrammyError } from "grammy";

export const TEXT_MAX_CHARS = 4096;
export const CALLBACK_DATA_MAX_BYTES = 64;

const TEXT_METHODS = new Set(["sendMessage", "editMessageText"]);

type Button = Record<string, unknown>;

function buttonProblem(b: Button): string | null {
  if (typeof b.text !== "string" || b.text.length === 0) return "Bad Request: BUTTON_TEXT_EMPTY";
  if ("callback_data" in b) {
    const data = b.callback_data;
    const bytes = typeof data === "string" ? Buffer.byteLength(data, "utf8") : 0;
    if (bytes < 1 || bytes > CALLBACK_DATA_MAX_BYTES) return `Bad Request: BUTTON_DATA_INVALID (${bytes} bytes, limit ${CALLBACK_DATA_MAX_BYTES})`;
  }
  if ("url" in b) {
    const url = b.url;
    let ok = typeof url === "string" && url.length > 0 && !/\s/.test(url);
    if (ok) {
      try {
        const u = new URL(url as string);
        ok = u.protocol === "https:" && u.hostname.length > 0;
      } catch {
        ok = false;
      }
    }
    if (!ok) return "Bad Request: BUTTON_URL_INVALID";
  }
  return null;
}

/** What Telegram would refuse in this call, as its error text, or null if it would accept it. */
export function telegramProblem(method: string, payload: Record<string, unknown>): string | null {
  if (TEXT_METHODS.has(method)) {
    const text = payload.text;
    if (typeof text !== "string" || text.length === 0) return "Bad Request: message text is empty";
    if (text.length > TEXT_MAX_CHARS) return `Bad Request: message is too long (${text.length} characters, limit ${TEXT_MAX_CHARS})`;
  }
  const markup = payload.reply_markup as { inline_keyboard?: unknown } | undefined;
  // a grammy InlineKeyboard is sent as JSON; read it the same way
  const rows = markup ? (JSON.parse(JSON.stringify(markup)) as { inline_keyboard?: Button[][] }).inline_keyboard : undefined;
  for (const row of rows ?? []) {
    for (const b of row) {
      const p = buttonProblem(b);
      if (p) return p;
    }
  }
  return null;
}

/** Throws the same GrammyError (400) that Telegram's refusal produces, if Telegram would refuse this call. */
export function enforceTelegramLimits(method: string, payload: Record<string, unknown>): void {
  const problem = telegramProblem(method, payload);
  if (problem) throw new GrammyError(`Call to '${method}' failed! (400: ${problem})`, { ok: false, error_code: 400, description: problem }, method, payload);
}
