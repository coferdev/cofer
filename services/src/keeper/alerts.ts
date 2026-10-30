/**
 * Keeper alerts (stale feeds, multiplier continuity). Each problem has a key; an alert is sent once
 * when the problem starts and once when it clears, never on every keeper run. It always goes to the
 * log, and to the private ops chat when OPS_CHAT_ID is set. Never to a group chat. Fixed text only.
 */
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client";
import { env } from "../env";
import { logAlert, redact } from "../core/errors";
import { enqueueChatMessage } from "../queues";

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
    async send(text) {
      logAlert(text);
      const chat = env().OPS_CHAT_ID;
      if (chat !== undefined) await enqueueChatMessage(chat, `Cofer alert: ${redact(text)}`);
    },
  };
}

/**
 * Reports the current state of one problem: `problem` is its text while it holds, null when it
 * does not. Returns what was sent ("opened" / "cleared") or null when nothing changed.
 */
export async function checkAlert(key: string, problem: string | null, deps: AlertDeps = alertDeps()): Promise<"opened" | "cleared" | null> {
  if (problem !== null) {
    if (!(await deps.open(key, problem))) return null;
    await deps.send(problem);
    return "opened";
  }
  const was = await deps.close(key);
  if (was === null) return null;
  await deps.send(`Cleared: ${was}`);
  return "cleared";
}
