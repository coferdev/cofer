/**
 * Plain relayer for permissionless CoferPot.execute(). It pays a few thousandths of a dollar of
 * ETH gas per call and holds no user funds; if it is down, ANY member (or anyone) can submit the
 * same calldata from the signer page or a block explorer.
 *
 * Member-initiated actions (deposit, spend, exit, leave, revokeVote) are userOps from each
 * member's own smart account on the signer site, gas-sponsored by the ZeroDev/Alchemy paymaster.
 */
import { eq } from "drizzle-orm";
import { BaseError, ContractFunctionRevertedError, decodeEventLog, type Hex } from "viem";
import { db, schema } from "../db/client";
import { potAbi, publicClient, relayerClient } from "../chain/clients";
import { buildExecuteArgs } from "../services/proposals";
import { Q, enqueueRelay, enqueueNotify, isFinalFailure, startWorker } from "../queues";
import { logError } from "../core/errors";
import { checkAlert } from "../keeper/alerts";
import { failureReason, RevertedOnChain, voteAlertKey, voteFailedText } from "./voteAlerts";
import { env } from "../env";

const PERMANENT = new Set(["NonceUsed", "StaleEpoch", "Expired", "UnknownKind", "AssetNotBuyable", "AdapterNotAllowed", "SlippageTooLoose"]);

export async function relayOnce(proposalId: Hex): Promise<"queued" | "executed" | "skipped"> {
  const row = await db().query.proposals.findFirst({ where: eq(schema.proposals.id, proposalId) });
  if (!row || !["ready", "queued"].includes(row.status)) return "skipped";
  if (row.status === "queued" && row.queuedEta && row.queuedEta > Math.floor(Date.now() / 1000)) {
    await enqueueRelay(proposalId, row.queuedEta + 2);
    return "skipped";
  }

  const { pot, args } = await buildExecuteArgs({ db: db(), client: publicClient(), chainId: env().CHAIN_ID }, proposalId);
  const wallet = relayerClient();
  try {
    const { request } = await publicClient().simulateContract({ account: wallet.account, address: pot, abi: potAbi, functionName: "execute", args });
    const hash = await wallet.writeContract(request);
    const receipt = await publicClient().waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new RevertedOnChain(hash);

    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== pot.toLowerCase()) continue;
      try {
        const ev = decodeEventLog({ abi: potAbi, data: log.data, topics: log.topics });
        if (ev.eventName === "ProposalQueued") {
          const eta = Number(ev.args.eta);
          await db().update(schema.proposals).set({ status: "queued", queuedEta: eta, txHash: hash }).where(eq(schema.proposals.id, proposalId));
          await enqueueRelay(proposalId, eta + 2);
          await enqueueNotify(proposalId);
          return "queued";
        }
        if (ev.eventName === "ProposalExecuted") {
          await db().update(schema.proposals).set({ status: "executed", txHash: hash }).where(eq(schema.proposals.id, proposalId));
          await enqueueNotify(proposalId);
          return "executed";
        }
      } catch {
        /* other events */
      }
    }
    return "skipped";
  } catch (e) {
    const name = revertName(e);
    if (name && PERMANENT.has(name)) {
      const status = name === "StaleEpoch" ? "stale" : name === "Expired" ? "expired" : "failed";
      await db().update(schema.proposals).set({ status, error: name }).where(eq(schema.proposals.id, proposalId));
      await enqueueNotify(proposalId);
      // stale and expired are normal outcomes members see on the card; only a failed vote is an ops problem
      if (status === "failed") await checkAlert(voteAlertKey(proposalId), voteFailedText(row, name, { permanent: true }));
      return "skipped";
    }
    // kept for the alert if this was the last try; the status is unchanged
    await db().update(schema.proposals).set({ error: failureReason(e) }).where(eq(schema.proposals.id, proposalId));
    throw e; // retried with backoff (e.g. TooEarly, InsufficientBalance after an exit, RPC errors)
  }
}

export function revertName(e: unknown): string | undefined {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) return r.data?.errorName;
  }
  return undefined;
}

/** Alerts the ops chat when a vote is still failing after its last retry. */
export async function alertStillFailing(proposalId: string, tries: number) {
  const row = await db().query.proposals.findFirst({ where: eq(schema.proposals.id, proposalId) });
  if (!row || !["ready", "queued"].includes(row.status)) return;
  await checkAlert(voteAlertKey(proposalId), voteFailedText(row, row.error ?? "unknown error", { tries }));
}

export function startRelayer() {
  const w = startWorker(Q.relay, async (job) => relayOnce(job.data.proposalId as Hex), { concurrency: 4 });
  w.on("failed", (job, err) => {
    if (job && isFinalFailure(job, err)) void alertStillFailing(job.data.proposalId, job.attemptsMade).catch((e) => logError("relayer alerts", e));
  });
  return w;
}
