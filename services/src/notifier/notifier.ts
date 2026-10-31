/**
 * Posts and edits proposal cards. Telegram limits groups to ~20 messages/minute, so each proposal
 * has ONE message that is edited in place; bursts are coalesced by the queue (see enqueueNotify).
 * A per-vote lock keeps it to one card even when two updates run at once; a deleted card is posted
 * again; Telegram's "too many requests" is waited out instead of failing.
 */
import { eq, sql } from "drizzle-orm";
import { DelayedError } from "bullmq";
import { GrammyError, type Api, type InlineKeyboard } from "grammy";
import { db, schema } from "../db/client";
import { getSignable } from "../services/proposals";
import { publicClient } from "../chain/clients";
import { Q, startWorker } from "../queues";
import { watchJobFailures } from "../keeper/jobAlerts";
import { proposalCard, assertNoMiniApp } from "../bot/keyboards";
import { humanPeriod } from "../core/proposal";
import { RateLimited } from "../bot/rateLimit";

export function renderCard(p: {
  summary: string;
  status: string;
  approvals: number;
  required: number;
  delaySeconds: number;
  queuedEta?: number | null;
  stale?: boolean;
}): string {
  const lines = [`Vote: ${p.summary}`, `Approvals: ${p.approvals}/${p.required}`];
  switch (p.status) {
    case "collecting":
      lines.push(p.delaySeconds > 0 ? `If it passes without everyone, it waits ${humanPeriod(p.delaySeconds)} so anyone who disagrees can exit first.` : "Executes as soon as it passes.");
      break;
    case "ready":
      lines.push("Passed. Submitting...");
      break;
    case "queued":
      lines.push(`Passed. Executes after ${p.queuedEta ? new Date(p.queuedEta * 1000).toUTCString() : "the exit window"}. Disagree? /exit takes your exact share any time.`);
      break;
    case "executed":
      lines.push("Done.");
      break;
    default:
      lines.push(`Status: ${p.status}${p.stale ? " (group settings changed; propose again)" : ""}`);
  }
  return lines.join("\n");
}

/** What a card update needs, so it can run against a stand-in in tests. */
export interface CardDeps {
  /** Runs `fn` holding this vote's lock, so two updates of one vote never both post a card. */
  withLock<T>(proposalId: string, fn: () => Promise<T>): Promise<T>;
  load(proposalId: string): Promise<{ chatId: number; messageId: number | null; text: string; open: boolean } | null>;
  send(chatId: number, text: string, kb?: InlineKeyboard): Promise<number>;
  edit(chatId: number, messageId: number, text: string, kb?: InlineKeyboard): Promise<void>;
  saveMessageId(proposalId: string, messageId: number): Promise<void>;
  /** What each card last showed (text and buttons), so an update that changes nothing sends nothing. */
  lastShown?: Map<string, string>;
}

const notModified = (e: unknown) => e instanceof Error && /message is not modified/i.test(e.message);
/** The card was deleted (e.g. by a group admin) or can no longer be edited: post a new one. */
const cardGone = (e: unknown) => e instanceof Error && /message to edit not found|message can't be edited|MESSAGE_ID_INVALID/i.test(e.message);

/** Telegram's "too many requests", or our own per-group budget: how long to wait, or null for any other error. */
export function retryAfterMs(e: unknown): number | null {
  if (e instanceof RateLimited) return e.retryAfterMs; // our own per-group budget (bot/rateLimit.ts)
  if (!(e instanceof GrammyError) || e.error_code !== 429) return null;
  return Math.max(1, e.parameters?.retry_after ?? 5) * 1000;
}

/** One card per vote: posted once, then edited in place; posted again only if it was deleted. */
export async function updateCard(proposalId: string, d: CardDeps): Promise<"posted" | "edited" | "unchanged" | "reposted" | "gone"> {
  return d.withLock(proposalId, async () => {
    const c = await d.load(proposalId);
    if (!c) return "gone";
    const kb = c.open ? proposalCard(proposalId) : undefined;
    if (kb) assertNoMiniApp(kb);
    const shown = `${c.open}|${c.messageId}|${c.text}`;
    if (c.messageId && d.lastShown?.get(proposalId) === shown) return "unchanged"; // merged with an earlier update: no call, no budget used
    if (c.messageId) {
      try {
        await d.edit(c.chatId, c.messageId, c.text, kb);
        d.lastShown?.set(proposalId, shown);
        return "edited";
      } catch (e) {
        if (notModified(e)) return "unchanged";
        if (!cardGone(e)) throw e;
      }
    }
    const messageId = await d.send(c.chatId, c.text, kb);
    await d.saveMessageId(proposalId, messageId);
    d.lastShown?.set(proposalId, `${c.open}|${messageId}|${c.text}`);
    return c.messageId ? "reposted" : "posted";
  });
}

const LAST_SHOWN_MAX = 5_000; // votes remembered per process (oldest forgotten first; forgetting only costs one edit)

function cardDeps(api: Api): CardDeps {
  const lastShown = new Map<string, string>();
  const remember = lastShown.set.bind(lastShown);
  lastShown.set = (k, v) => {
    lastShown.delete(k);
    remember(k, v);
    if (lastShown.size > LAST_SHOWN_MAX) lastShown.delete(lastShown.keys().next().value!);
    return lastShown;
  };
  return {
    lastShown,
    // a Postgres lock per vote, held for the update and released when the transaction ends
    withLock: (id, fn) =>
      db().transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${id}, 0))`);
        return fn();
      }),
    async load(id) {
      const row = await db().query.proposals.findFirst({ where: eq(schema.proposals.id, id) });
      if (!row) return null;
      const pot = await db().query.pots.findFirst({ where: eq(schema.pots.address, row.pot) });
      if (!pot) return null;
      const s = await getSignable({ db: db(), client: publicClient() }, id as `0x${string}`);
      const text = renderCard({
        summary: row.summary,
        status: row.status,
        approvals: s.tally.approvals,
        required: s.tally.required,
        delaySeconds: s.tally.delaySeconds,
        queuedEta: row.queuedEta,
        stale: s.stale,
      });
      return { chatId: pot.chatId, messageId: row.chatMessageId, text, open: row.status === "collecting" || row.status === "ready" };
    },
    send: async (chatId, text, kb) => (await api.sendMessage(chatId, text, kb ? { reply_markup: kb } : {})).message_id,
    edit: async (chatId, messageId, text, kb) => {
      await api.editMessageText(chatId, messageId, text, kb ? { reply_markup: kb } : {});
    },
    saveMessageId: async (id, messageId) => {
      await db().update(schema.proposals).set({ chatMessageId: messageId }).where(eq(schema.proposals.id, id));
    },
  };
}

export function startNotifier(api: Api) {
  const deps = cardDeps(api);
  const w = startWorker(
    Q.notify,
    async (job, token) => {
      try {
        if (job.name === "text") await api.sendMessage(job.data.chatId, job.data.text);
        else await updateCard(job.data.proposalId, deps);
      } catch (e) {
        // too many requests: wait as long as Telegram asks, without using up a try
        const wait = retryAfterMs(e);
        if (wait !== null && token) {
          await job.moveToDelayed(Date.now() + wait, token);
          throw new DelayedError();
        }
        throw e;
      }
    },
    { concurrency: 2, limiter: { max: 25, duration: 1000 } },
  );
  watchJobFailures(w);
  return w;
}
