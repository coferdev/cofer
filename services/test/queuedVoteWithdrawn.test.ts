import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Address, Hex } from "viem";
import type { AlertMessage } from "../src/core/alertFormat";
import { onApprovalLost, onExecutedAfterWithdrawal, queuedApprovedQuery, type QueuedRow, wasQueued, withdrawnText } from "../src/indexer/withdrawnVotes";

const POT = "0x2D3365a056074f6cd35C943EDcE644FAE7Eb8A45" as Address;
const A = "0x00000000000000000000000000000000000A0A00" as Address;
const D1 = `0x${"11".repeat(32)}` as Hex;
const D2 = `0x${"22".repeat(32)}` as Hex;
const row = (x: Partial<QueuedRow> = {}): QueuedRow => ({ id: D1, pot: POT, kind: 0, status: "queued", queuedEta: 1_800_000_000, ...x });

function deps(rows: QueuedRow[], chat: number | null = -100) {
  const marked: Hex[] = [];
  const group: string[] = [];
  const ops: AlertMessage[] = [];
  return {
    marked, group, ops,
    d: {
      queuedApprovedBy: async () => rows,
      markWithdrawn: async (id: Hex) => void marked.push(id),
      chatOf: async () => chat,
      sendGroup: async (_c: number, t: string) => void group.push(t),
      sendOps: async (m: AlertMessage) => void ops.push(m),
    },
  };
}

describe("a queued vote that loses an approval is withdrawn for good", () => {
  test("a withdrawal or an approving member leaving marks every queued vote stale and tells the group", async () => {
    const x = deps([row(), row({ id: D2, status: "ready" })]);
    expect(await onApprovalLost(x.d, { pot: POT, member: A, isNew: true })).toEqual([D1, D2]);
    expect(x.marked).toEqual([D1, D2]);
    expect(x.group).toEqual([withdrawnText(0), withdrawnText(0)]);
    expect(x.group[0]).toContain("will not collect approvals for it or send it again");
  });

  test("a vote not yet queued (no exit window started) is left alone; a re-run sends nothing twice", async () => {
    const x = deps([row({ queuedEta: null, status: "ready" }), row({ id: D2, status: "collecting" })]);
    expect(await onApprovalLost(x.d, { pot: POT, member: A, isNew: true })).toEqual([]);
    const y = deps([row()]);
    expect(await onApprovalLost(y.d, { pot: POT, member: A, isNew: false })).toEqual([]);
    expect(y.marked.length + y.group.length).toBe(0);
    expect(wasQueued({ status: "executed", queuedEta: 1 })).toBe(false);
  });

  test("if the pot still runs a withdrawn vote, the group and the staff chat are alerted", async () => {
    const x = deps([]);
    expect(await onExecutedAfterWithdrawal(x.d, { before: row({ status: "stale" }), isNew: true })).toBe(true);
    expect(x.group[0]).toContain("had been withdrawn just ran");
    expect(x.ops[0]!.name).toBe("vote-revived");
    // a normal execution, a vote staled by a settings change before it was queued, or a re-run: no alert
    for (const before of [row({ status: "queued" }), row({ status: "stale", queuedEta: null }), null]) expect(await onExecutedAfterWithdrawal(x.d, { before, isNew: true })).toBe(false);
    expect(await onExecutedAfterWithdrawal(x.d, { before: row({ status: "stale" }), isNew: false })).toBe(false);
  });
});

const DBURL = process.env.TEST_PG_URL ?? process.env.ARENA_TEST_DATABASE_URL;
describe.skipIf(!DBURL)("the query on Postgres", () => {
  test("finds the right queued votes for a withdrawal and for a member leaving", async () => {
    const pg = postgres(DBURL!, { max: 1, onnotice: () => {} });
    const db = drizzle(pg);
    try {
      await pg`create temporary table proposals (id text primary key, pot text, kind smallint, status text, queued_eta bigint)`;
      await pg`create temporary table signatures (proposal_id text, signer text, revoked boolean not null default false)`;
      const B = "0x00000000000000000000000000000000000B0B00";
      const D3 = `0x${"33".repeat(32)}` as Hex;
      const D4 = `0x${"44".repeat(32)}` as Hex;
      await pg`insert into proposals values (${D1}, ${POT}, 0, 'queued', 1800000000), (${D2}, ${POT}, 1, 'queued', 1800000000), (${D3}, ${POT}, 0, 'ready', null), (${D4}, ${POT}, 0, 'executed', 1700000000)`;
      await pg`insert into signatures values (${D1}, ${A}, false), (${D2}, ${A}, true), (${D3}, ${A}, false), (${D4}, ${A}, false), (${D2}, ${B}, false)`;
      const ids = async (digest?: Hex, m: string = A) => ((await db.execute(queuedApprovedQuery(POT, m as Address, digest))) as unknown as QueuedRow[]).map((r) => r.id).sort();
      expect(await ids()).toEqual([D1]); // A leaves: only the queued vote A's approval still counted in
      expect(await ids(D2)).toEqual([D2]); // A withdraws D2 (the indexer marks the signature revoked afterwards)
      expect(await ids(D3)).toEqual([]); // not queued yet
      expect(await ids(undefined, B)).toEqual([D2]);
    } finally {
      await pg.end();
    }
  });
});
