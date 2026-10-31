/**
 * Runtime guard for Telegram compliance: this bot never attaches a Mini App. Installed on every
 * Telegram API client (the bot, which the notifier shares, and the alerts bot), it refuses before
 * sending any call that would add one:
 *  - a Mini App method (menu button, Mini App answers, prepared Mini App messages)
 *  - a web_app (or login_url) button or menu anywhere in the request: inline keyboards, reply
 *    keyboards, menu buttons
 * assertNoMiniApp (keyboards.ts) checks keyboards where they are built; this checks what is sent.
 */
import type { Transformer } from "grammy";

export const FORBIDDEN_METHODS: ReadonlySet<string> = new Set(["setChatMenuButton", "answerWebAppQuery", "savePreparedInlineMessage"]);
const FORBIDDEN_KEYS = new Set(["web_app", "login_url"]);

/** Why this call is refused, or null if it may be sent. */
export function miniAppProblem(method: string, payload: unknown): string | null {
  if (FORBIDDEN_METHODS.has(method)) return `${method} is not allowed on this bot`;
  const seen = new WeakSet<object>();
  const walk = (v: unknown, depth: number): string | null => {
    if (!v || typeof v !== "object" || depth > 10 || seen.has(v)) return null;
    seen.add(v);
    for (const [k, x] of Object.entries(v)) {
      if (FORBIDDEN_KEYS.has(k)) return `a ${k} button is not allowed on this bot`;
      if (k === "type" && x === "web_app") return "a web_app menu is not allowed on this bot";
      const found = walk(x, depth + 1);
      if (found) return found;
    }
    return null;
  };
  return walk(payload, 0);
}

/** Refuses the call (it never reaches Telegram) with a fixed error. */
export const noMiniApp: Transformer = (prev, method, payload, signal) => {
  const problem = miniAppProblem(method, payload);
  if (problem) throw new Error(`Mini App guard: ${problem}`);
  return prev(method, payload, signal);
};
