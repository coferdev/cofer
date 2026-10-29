/**
 * Posts and edits proposal cards. Telegram limits groups to ~20 messages/minute, so each proposal
 * has ONE message that is edited in place; bursts are coalesced by the queue (see enqueueNotify).
 */
import { Worker } from "bullmq";
import { eq } from "drizzle-orm";
import type { Api } from "grammy";
import { db, schema } from "../db/client";
import { getSignable } from "../services/proposals";
import { publicClient } from "../chain/clients";
import { Q, redis } from "../queues";
import { proposalCard, assertNoMiniApp } from "../bot/keyboards";
import { humanPeriod } from "../core/proposal";

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

export function startNotifier(api: Api) {
  return new Worker(
    Q.notify,
    async (job) => {
      if (job.name === "text") {
        await api.sendMessage(job.data.chatId, job.data.text);
        return;
      }
      const id = job.data.proposalId as `0x${string}`;
      const row = await db().query.proposals.findFirst({ where: eq(schema.proposals.id, id) });
      if (!row) return;
      const pot = await db().query.pots.findFirst({ where: eq(schema.pots.address, row.pot) });
      if (!pot) return;
      const s = await getSignable({ db: db(), client: publicClient() }, id);
      const text = renderCard({
        summary: row.summary,
        status: row.status,
        approvals: s.tally.approvals,
        required: s.tally.required,
        delaySeconds: s.tally.delaySeconds,
        queuedEta: row.queuedEta,
        stale: s.stale,
      });
      const open = row.status === "collecting" || row.status === "ready";
      const kb = open ? proposalCard(id) : undefined;
      if (kb) assertNoMiniApp(kb);
      if (row.chatMessageId) {
        await api.editMessageText(pot.chatId, row.chatMessageId, text, kb ? { reply_markup: kb } : {}).catch((e: Error) => {
          if (!/message is not modified/.test(e.message)) throw e;
        });
      } else {
        const msg = await api.sendMessage(pot.chatId, text, kb ? { reply_markup: kb } : {});
        await db().update(schema.proposals).set({ chatMessageId: msg.message_id }).where(eq(schema.proposals.id, id));
      }
    },
    { connection: redis(), concurrency: 2, limiter: { max: 25, duration: 1000 } },
  );
}
