/**
 * The team bot's Telegram calls, on the existing alert bot (ALERT_BOT_TOKEN). Plain bot only: the
 * no-Mini-App guard is installed, like on every other Telegram client here. Errors carry only
 * Telegram's own code and description (never the token or the request). "Too many requests" is
 * waited out and tried again; a network failure is tried again a few times.
 */
import { Api, GrammyError, InputFile } from "grammy";
import { redact } from "../core/errors";
import { noMiniApp } from "../bot/noMiniApp";

export interface TgMessage {
  message_id: number;
  chat: { id: number };
  from?: { is_bot?: boolean };
  text?: string;
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

/** What the team bot needs from Telegram. Tests use a stand-in. */
export interface Tg {
  send(chat: number, html: string): Promise<number>;
  photo(chat: number, file: string, caption: string, html?: boolean): Promise<number>;
  edit(chat: number, messageId: number, html: string): Promise<void>;
  pin(chat: number, messageId: number): Promise<void>;
  me(): Promise<string>;
  setCommands(chat: number, commands: [string, string][]): Promise<void>;
  updates(offset: number, timeoutSec: number): Promise<TgUpdate[]>;
  copy(chat: number, fromChat: number, messageId: number): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function telegramClient(token: string, o: { fetch?: typeof fetch; wait?: (ms: number) => Promise<void> } = {}): Tg {
  const api = new Api(token, o.fetch ? { fetch: o.fetch } : undefined);
  api.config.use(noMiniApp);
  const wait = o.wait ?? sleep;
  const clean = (s: string) => redact(s).replaceAll(token, "<token>");

  async function call<T>(method: string, fn: () => Promise<T>, tries = 4): Promise<T> {
    for (let i = 0; ; i++) {
      try {
        return await fn();
      } catch (e) {
        if (e instanceof GrammyError) {
          if (e.error_code === 429 && i < tries - 1) {
            await wait(((e.parameters?.retry_after ?? 5) + 1) * 1000);
            continue;
          }
          throw new Error(`Telegram said ${e.error_code} ${clean(e.description)} (${method})`);
        }
        if (e instanceof Error && e.message.startsWith("Mini App guard:")) throw new Error(e.message);
        if (i < tries - 1) {
          await wait(2000 * (i + 1));
          continue;
        }
        throw new Error(`Telegram could not be reached (${method})`);
      }
    }
  }
  const html = { parse_mode: "HTML" as const, link_preview_options: { is_disabled: true } };

  return {
    send: async (chat, text) => (await call("sendMessage", () => api.sendMessage(chat, text, html))).message_id,
    photo: async (chat, file, caption, isHtml) =>
      (await call("sendPhoto", () => api.sendPhoto(chat, new InputFile(file), { caption, ...(isHtml ? { parse_mode: "HTML" as const } : {}) }))).message_id,
    edit: async (chat, id, text) => void (await call("editMessageText", () => api.editMessageText(chat, id, text, html), 1)),
    pin: async (chat, id) => void (await call("pinChatMessage", () => api.pinChatMessage(chat, id, { disable_notification: true }))),
    me: async () => (await call("getMe", () => api.getMe())).username,
    setCommands: async (chat, commands) =>
      void (await call("setMyCommands", () => api.setMyCommands(commands.map(([command, description]) => ({ command, description })), { scope: { type: "chat", chat_id: chat } }))),
    updates: async (offset, timeout) => (await call("getUpdates", () => api.getUpdates({ offset, timeout, allowed_updates: ["message"] }), 1)) as TgUpdate[],
    copy: async (chat, from, id) => void (await call("copyMessage", () => api.copyMessage(chat, from, id))),
  };
}
