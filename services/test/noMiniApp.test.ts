import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Api, InlineKeyboard, Keyboard } from "grammy";
import { FORBIDDEN_METHODS, miniAppProblem, noMiniApp } from "../src/bot/noMiniApp";

/** A real grammY client with the guard, talking to a stand-in Telegram that records each call. */
function guardedApi() {
  const reached: string[] = [];
  const api = new Api("1:TEST", {
    fetch: (async (url: string) => {
      reached.push(String(url).split("/").pop()!);
      return Response.json({ ok: true, result: true });
    }) as unknown as typeof fetch,
  });
  api.config.use(noMiniApp);
  return { api, reached };
}

describe("the runtime Mini App guard: refused calls never reach Telegram", () => {
  test("an inline web_app button", async () => {
    const { api, reached } = guardedApi();
    const kb = new InlineKeyboard().url("ok", "https://sign.example").webApp("app", "https://example.com");
    await expect(api.sendMessage(-100, "hi", { reply_markup: kb })).rejects.toThrow("Mini App guard: a web_app button is not allowed on this bot");
    expect(reached).toEqual([]);
  });

  test("a reply-keyboard web_app button", async () => {
    const { api, reached } = guardedApi();
    const kb = new Keyboard().webApp("app", "https://example.com");
    await expect(api.sendMessage(-100, "hi", { reply_markup: kb })).rejects.toThrow("web_app button");
    expect(reached).toEqual([]);
  });

  test("a web_app button added by editing a card", async () => {
    const { api, reached } = guardedApi();
    const kb = new InlineKeyboard().webApp("app", "https://example.com");
    await expect(api.editMessageText(-100, 5, "card", { reply_markup: kb })).rejects.toThrow("web_app button");
    expect(reached).toEqual([]);
  });

  test("the menu button, in any form, and the other Mini App methods", async () => {
    const { api, reached } = guardedApi();
    await expect(api.setChatMenuButton({ menu_button: { type: "web_app", text: "Open", web_app: { url: "https://example.com" } } })).rejects.toThrow("setChatMenuButton is not allowed");
    await expect(api.setChatMenuButton({ menu_button: { type: "default" } })).rejects.toThrow("setChatMenuButton is not allowed");
    expect([...FORBIDDEN_METHODS].sort()).toEqual(["answerWebAppQuery", "savePreparedInlineMessage", "setChatMenuButton"]);
    expect(reached).toEqual([]);
  });

  test("a login_url button (refused by assertNoMiniApp too)", () => {
    expect(miniAppProblem("sendMessage", { reply_markup: { inline_keyboard: [[{ text: "x", login_url: { url: "https://x" } }]] } })).toBe("a login_url button is not allowed on this bot");
  });

  test("normal calls pass: url buttons, callback buttons, edits, deletes, ephemeral messages", async () => {
    const { api, reached } = guardedApi();
    const kb = new InlineKeyboard().url("Deposit", "https://sign.example/s/x").text("Details", "info:0x1");
    await api.sendMessage(-100, "card", { reply_markup: kb, ephemeral_message_parameters: { receiver_user_id: 7 } });
    await api.editMessageText(-100, 5, "card", { reply_markup: kb });
    await api.deleteMessage(-100, 5);
    expect(reached).toEqual(["sendMessage", "editMessageText", "deleteMessage"]);
  });

  test("odd payloads (deep, or pointing at themselves) do not break it", () => {
    const loop: Record<string, unknown> = { a: 1 };
    loop.self = loop;
    expect(miniAppProblem("sendMessage", loop)).toBeNull();
    expect(miniAppProblem("sendMessage", null)).toBeNull();
    expect(miniAppProblem("sendMessage", { a: { b: { c: [{ web_app: {} }] } } })).toContain("web_app");
  });
});

describe("installed on every Telegram client", () => {
  const src = (...p: string[]) => readFileSync(join(import.meta.dir, "..", "src", ...p), "utf8");
  test("the bot (shared with the notifier) and the alerts bot", () => {
    expect(src("bot", "bot.ts")).toMatch(/const bot = new Bot\(env\(\)\.TELEGRAM_BOT_TOKEN\);\n  bot\.api\.config\.use\(noMiniApp\);/);
    expect(src("keeper", "alerts.ts")).toMatch(/const api = new Api\(token[^\n]*\n  api\.config\.use\(noMiniApp\);/);
    expect(src("index.ts")).toContain("startNotifier(bot.api)");
  });
});
