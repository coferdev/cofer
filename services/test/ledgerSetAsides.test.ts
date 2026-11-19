import { describe, expect, test } from "bun:test";
import { position, runProjection, type EventIn, type LedgerStore } from "../src/indexer/projections/runner";
import { applySetAsides, setAsidesProjection, type SetAsideChange } from "../src/indexer/projections/setAsides";

const POT = "0x50F19AdD1EE10AF538C1F8bE5bcbA4011F100115";
const TSTA = "0x3232dDDE4c6a3FE39Fd17696791D50B54Bc52fFE";
const OUTSIDER = "0x00000000000000000000000000000000000000f1"; // an exit's destination that is not a member
const ev = (block: bigint, logIndex: number, name: string, amount: bigint, account = OUTSIDER): EventIn => ({ block, logIndex, txHash: `0x${block.toString(16).padStart(64, "0")}`, address: POT, name, args: { asset: TSTA, account, amount: amount.toString() } });

/** A ledger store in memory, with the same contract as the database one. */
function memoryStore(events: EventIn[]) {
  const cursors = new Map<string, bigint>();
  const ledger = new Map<string, SetAsideChange>();
  let commits = 0;
  const store: LedgerStore<SetAsideChange> = {
    cursor: async (n) => cursors.get(n) ?? null,
    events: async (after, names, limit) => events.filter((e) => names.includes(e.name) && (after === null || position(e.block, e.logIndex) > after)).slice(0, limit),
    commit: async (n, to, changes) => {
      applySetAsides(ledger, changes);
      cursors.set(n, to);
      commits++;
    },
  };
  return { store, ledger, cursors, commits: () => commits };
}

const EVENTS = [ev(100n, 1, "ExitOwed", 10n), ev(105n, 0, "OwedClaimed", 4n), ev(106n, 2, "ExitOwed", 7n), ev(107n, 0, "Deposited", 1n), ev(110n, 3, "OwedClaimed", 13n)];

describe("set-aside ledger", () => {
  test("set aside, then partly claimed, then fully claimed", async () => {
    const m = memoryStore(EVENTS.slice(0, 2));
    await runProjection(setAsidesProjection, m.store);
    let row = [...m.ledger.values()][0]!;
    expect([row.setAside, row.claimed, row.setAside - row.claimed]).toEqual([10n, 4n, 6n]);
    const all = memoryStore(EVENTS);
    await runProjection(setAsidesProjection, all.store);
    row = [...all.ledger.values()][0]!;
    expect([row.setAside, row.claimed, row.setAside - row.claimed, row.lastBlock]).toEqual([17n, 17n, 0n, 110n]);
    expect(row.account).toBe(OUTSIDER);
  });

  test("a backfill in one go equals running step by step, and a second run counts nothing twice", async () => {
    const once = memoryStore(EVENTS);
    await runProjection(setAsidesProjection, once.store);
    const steps = memoryStore(EVENTS);
    await runProjection(setAsidesProjection, steps.store, 1);
    await runProjection(setAsidesProjection, steps.store, 1);
    expect([...steps.ledger.values()]).toEqual([...once.ledger.values()]);
    expect(steps.cursors.get("ledger:set_asides")).toBe(position(110n, 3));
    expect(steps.commits()).toBe(4); // the Deposited event is not one of its events
  });

  test("only its own events are read; recipients are kept apart", () => {
    const changes = setAsidesProjection.reduce([ev(1n, 0, "ExitOwed", 5n), ev(1n, 1, "ExitOwed", 3n, "0x00000000000000000000000000000000000000f2")]);
    expect(changes.map((c) => [c.account, c.setAside])).toEqual([[OUTSIDER, 5n], ["0x00000000000000000000000000000000000000f2", 3n]]);
    expect(setAsidesProjection.events).toEqual(["ExitOwed", "OwedClaimed"]);
  });
});
