/**
 * /newpot makes the relayer pay gas for CoferFactory.createPot. Each Telegram user may open at most
 * NEWPOT_LIMIT.max group accounts per NEWPOT_LIMIT.windowMs (shared across processes through the
 * same Redis counter as the chat rate limit). The slot is taken before any transaction is sent.
 */
import type { RateStore } from "./rateLimit";

export const NEWPOT_LIMIT = { max: 2, windowMs: 24 * 3600_000 };

/** null when this user may open a group account now; otherwise the fixed text to reply with. */
export async function newPotRefusal(store: RateStore, tgId: number, nowMs = Date.now()): Promise<string | null> {
  const waitMs = await store.take(`newpot:${tgId}`, NEWPOT_LIMIT.max, NEWPOT_LIMIT.windowMs, nowMs);
  if (waitMs === 0) return null;
  const hours = Math.max(1, Math.ceil(waitMs / 3600_000));
  return `You opened a group account recently. Try again in about ${hours} hour${hours === 1 ? "" : "s"}.`;
}
