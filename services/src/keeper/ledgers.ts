/**
 * The keeper's "ledgers" job (every minute): brings every ledger up to the newest stored chain event
 * (indexer/projections). Each ledger's position is kept in the cursors table as "ledger:<name>".
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "../db/client";
import { logError } from "../core/errors";
import { runProjection, type EventIn, type LedgerStore, type Projection } from "../indexer/projections/runner";
import { setAsidesProjection, type SetAsideChange } from "../indexer/projections/setAsides";
import { adminQueueProjection, type AdminOp } from "../indexer/projections/adminQueue";
import { env } from "../env";

type Tx = Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0];

/** A ledger store on the database: the changes are written by `write`, in the same transaction as the position. */
export function sqlStore<D>(write: (tx: Tx, changes: D[]) => Promise<void>): LedgerStore<D> {
  return {
    async cursor(name) {
      return (await db().query.cursors.findFirst({ where: eq(schema.cursors.name, name) }))?.block ?? null;
    },
    async events(after, names, limit) {
      const pos = sql`(${schema.chainEvents.block} * 1000000 + ${schema.chainEvents.logIndex})`;
      const rows = await db()
        .select({ block: schema.chainEvents.block, logIndex: schema.chainEvents.logIndex, txHash: schema.chainEvents.txHash, address: schema.chainEvents.address, name: schema.chainEvents.name, args: schema.chainEvents.args })
        .from(schema.chainEvents)
        .where(after === null ? inArray(schema.chainEvents.name, names) : and(inArray(schema.chainEvents.name, names), sql`${pos} > ${after.toString()}::numeric`))
        .orderBy(asc(schema.chainEvents.block), asc(schema.chainEvents.logIndex))
        .limit(limit);
      return rows.map((r) => ({ ...r, args: r.args as Record<string, unknown> })) as EventIn[];
    },
    async commit(name, to, changes) {
      await db().transaction(async (tx) => {
        await write(tx, changes);
        await tx.insert(schema.cursors).values({ name, block: to }).onConflictDoUpdate({ target: schema.cursors.name, set: { block: to } });
      });
    },
  };
}

export async function writeSetAsides(tx: Tx, changes: SetAsideChange[]) {
  for (const c of changes)
    await tx
      .insert(schema.setAsides)
      .values({ pot: c.pot, asset: c.asset, account: c.account, setAside: c.setAside.toString(), claimed: c.claimed.toString(), lastBlock: c.lastBlock })
      .onConflictDoUpdate({
        target: [schema.setAsides.pot, schema.setAsides.asset, schema.setAsides.account],
        set: {
          setAside: sql`${schema.setAsides.setAside} + ${c.setAside.toString()}::numeric`,
          claimed: sql`${schema.setAsides.claimed} + ${c.claimed.toString()}::numeric`,
          lastBlock: sql`greatest(${schema.setAsides.lastBlock}, ${c.lastBlock.toString()}::bigint)`,
        },
      });
}

export async function writeAdminOps(tx: Tx, ops: AdminOp[]) {
  const t = schema.pendingAdminChanges;
  for (const o of ops) {
    if (o.op === "queue") {
      const c = o.change;
      await tx.update(t).set({ state: "replaced", resolvedBlock: c.queuedBlock, resolvedTx: c.queuedTx }).where(and(eq(t.state, "queued"), eq(t.kind, c.kind), eq(sql`lower(${t.subject})`, c.subject.toLowerCase()), sql`${t.id} <> ${c.id}`));
      await tx.insert(t).values({ id: c.id, kind: c.kind, subject: c.subject, newValue: c.newValue, maxStaleness: c.maxStaleness, eta: c.eta, queuedBlock: c.queuedBlock, queuedTx: c.queuedTx, state: "queued" }).onConflictDoNothing();
    } else {
      const latest = await tx.select({ id: t.id }).from(t).where(and(eq(t.state, "queued"), eq(t.kind, o.kind), eq(sql`lower(${t.subject})`, o.subject.toLowerCase()))).orderBy(sql`${t.queuedBlock} desc`).limit(1);
      if (latest[0]) await tx.update(t).set({ state: "applied", resolvedBlock: o.block, resolvedTx: o.tx }).where(eq(t.id, latest[0].id));
    }
  }
}

/** Every ledger the job runs, with its writer. Later ledgers add themselves here. */
export const LEDGERS = (): { projection: Projection<never>; write: (tx: Tx, changes: never[]) => Promise<void> }[] => [
  { projection: setAsidesProjection as Projection<never>, write: writeSetAsides as never },
  { projection: adminQueueProjection(env().FACTORY_ADDRESS) as Projection<never>, write: writeAdminOps as never },
];

export async function runLedgers(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const l of LEDGERS()) {
    try {
      out[l.projection.name] = await runProjection(l.projection, sqlStore(l.write));
    } catch (e) {
      logError(`cofer-keeper ${l.projection.name}`, e);
      throw e;
    }
  }
  return out;
}
