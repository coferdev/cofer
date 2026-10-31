/**
 * Keeper alerts (stale feeds, multiplier continuity). Each problem has a key; an alert is sent once
 * when the problem starts and once when it clears, never on every keeper run. It always goes to the
 * log, and to the private ops chat when OPS_CHAT_ID is set. Never to a group chat. Fixed text only.
 *
 * With ALERT_BOT_TOKEN, alerts go straight from this process through that separate bot (so they
 * still arrive when the notifier or the main bot is down); without it, through the notifier.
 */
import { eq } from "drizzle-orm";
import { Api, GrammyError } from "grammy";
import { db, schema } from "../db/client";
import { env } from "../env";
import { logAlert, logError, redact } from "../core/errors";
import { enqueueChatMessage } from "../queues";

type ChatSend = (chat: number, text: string) => Promise<void>;

/**
 * Sends through the alerts bot. A failure becomes a fixed error holding only Telegram's own error
 * code and description (e.g. "403 Forbidden: bot can't initiate conversation with a user"), never
 * the request, its URL or the token, and with no cause attached.
 */
export function alertBotSender(token: string, fetchImpl?: typeof fetch): ChatSend {
  const api = new Api(token, fetchImpl ? { fetch: fetchImpl } : undefined);
  return async (chat, text) => {
    try {
      await api.sendMessage(chat, text);
    } catch (e) {
      if (e instanceof GrammyError) throw new Error(`alerts bot: Telegram said ${e.error_code} ${redact(e.description).replaceAll(token, "<token>")}`);
      throw new Error("alerts bot: could not reach Telegram");
    }
  };
}

/** Log always; then the ops chat, through the alerts bot if there is one, else the notifier queue. */
export async function deliver(text: string, o: { chat?: number; botSend?: ChatSend; enqueue: ChatSend }): Promise<void> {
  logAlert(text);
  if (o.chat === undefined) return;
  const line = `Cofer alert: ${redact(text)}`;
  await (o.botSend ?? o.enqueue)(o.chat, line);
}

let _botSend: ChatSend | undefined;
function botSend(): ChatSend | undefined {
  const token = env().ALERT_BOT_TOKEN;
  if (!token) return undefined;
  _botSend ??= alertBotSender(token);
  return _botSend;
}

export interface AlertDeps {
  /** Records the alert as open; false if it was already open. */
  open(key: string, text: string): Promise<boolean>;
  /** Removes an open alert and returns its text, or null if it was not open. */
  close(key: string): Promise<string | null>;
  /** Delivers one line (log, plus the ops chat if set). */
  send(text: string): Promise<void>;
}

export function alertDeps(): AlertDeps {
  return {
    async open(key, text) {
      const rows = await db().insert(schema.alerts).values({ key, text }).onConflictDoNothing().returning({ key: schema.alerts.key });
      return rows.length > 0;
    },
    async close(key) {
      const rows = await db().delete(schema.alerts).where(eq(schema.alerts.key, key)).returning({ text: schema.alerts.text });
      return rows[0]?.text ?? null;
    },
    send: (text) => deliver(text, { chat: env().OPS_CHAT_ID, botSend: botSend(), enqueue: enqueueChatMessage }),
  };
}

/**
 * Reports the current state of one problem: `problem` is its text while it holds, null when it
 * does not. Returns what was sent ("opened" / "cleared") or null when nothing changed.
 * If delivery fails, the change is undone (so the next run sends it again) and the failure is
 * logged; it never throws, so one failed message does not stop the checks after it.
 */
export async function checkAlert(key: string, problem: string | null, deps: AlertDeps = alertDeps()): Promise<"opened" | "cleared" | null> {
  if (problem !== null) {
    if (!(await deps.open(key, problem))) return null;
    try {
      await deps.send(problem);
    } catch (e) {
      logError("alerts", e);
      await deps.close(key);
      return null;
    }
    return "opened";
  }
  const was = await deps.close(key);
  if (was === null) return null;
  try {
    await deps.send(`Cleared: ${was}`);
  } catch (e) {
    logError("alerts", e);
    await deps.open(key, was);
    return null;
  }
  return "cleared";
}
