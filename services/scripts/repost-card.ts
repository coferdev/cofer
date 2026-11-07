/**
 * Posts (or refreshes) one vote card in its group again, by adding one card job to the notifier
 * queue through the normal enqueueNotify. For a card that never appeared, for example after the
 * notifier's card job failed.
 *
 *   cd services && bun scripts/repost-card.ts 0x<64 hex proposal id>
 *
 * It sends no transaction and changes nothing on chain. It reads the proposal from the database,
 * refuses an id that is not a stored proposal, adds the job, and prints what it queued. The running
 * notifier then posts the card (or edits it, if it is already there) exactly as it normally would.
 */
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/client";
import { enqueueNotify, queues } from "../src/queues";

function stop(msg: string, code: number): never {
  console.error(`repost-card: ${msg}`);
  process.exit(code);
}

const args = process.argv.slice(2);
if (args.length !== 1) stop("give exactly one proposal id.\nUsage: bun scripts/repost-card.ts 0x<64 hex proposal id>", 2);
const id = args[0]!.toLowerCase();
if (!/^0x[0-9a-f]{64}$/.test(id)) stop("that is not a proposal id (0x followed by 64 hex characters).", 2);

const row = await db().query.proposals.findFirst({ where: eq(schema.proposals.id, id) });
if (!row) stop(`no stored proposal has the id ${id}. Nothing was queued.`, 1);
const pot = await db().query.pots.findFirst({ where: eq(schema.pots.address, row.pot) });
if (!pot) stop(`the proposal's group account ${row.pot} is not stored. Nothing was queued.`, 1);

const before = Date.now();
await enqueueNotify(id);
// find the job just added, to print its exact name
const jobs = await queues().notify.getJobs(["delayed", "waiting", "active", "completed"], 0, 200);
const job = jobs.find((j) => j.name === "card" && j.data?.proposalId === id && j.timestamp >= before - 3_000);

const open = row.status === "collecting" || row.status === "ready";
console.log(
  [
    "Queued one card job (no transaction, nothing on chain).",
    `  job:      ${job?.id ?? "(added; a job for this vote from the last 3 seconds was already waiting, so the two were merged)"}`,
    `  proposal: ${id}`,
    `  summary:  ${row.summary}`,
    `  status:   ${row.status}${open ? " (the card will have the Approve / review and Details buttons)" : " (the card will show this status, with no buttons)"}`,
    `  group:    ${pot.title} (chat ${pot.chatId})`,
    `  card:     ${row.chatMessageId ? `already posted (message ${row.chatMessageId}); it will be edited in place` : "not posted yet; it will be posted"}`,
    "The notifier posts it in about 2 seconds. Check the group, and the cofer-notify queue for failures.",
  ].join("\n"),
);

await queues().notify.close();
process.exit(0);
