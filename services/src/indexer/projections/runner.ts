/**
 * Ledgers built from the indexer's stored chain events (chain_events), by the keeper, never inside the indexer's own
 * loop, so a ledger can never slow or stop indexing. Each ledger reads the events it cares about after its saved
 * position, turns them into changes (a pure function), and writes the changes and its new position in one database
 * transaction: run twice, nothing is counted twice; run from the start (a backfill), the result is the same as
 * running step by step.
 */

export interface EventIn {
  block: bigint;
  logIndex: number;
  txHash: string;
  address: string;
  name: string;
  args: Record<string, unknown>;
}

/** A position in the chain: block and log index, as one number (log indexes stay far below a million). */
export const position = (block: bigint, logIndex: number) => block * 1_000_000n + BigInt(logIndex);
export const fromPosition = (p: bigint) => ({ block: p / 1_000_000n, logIndex: Number(p % 1_000_000n) });

export interface Projection<D> {
  name: string;
  /** Event names it reads. */
  events: string[];
  /** The changes these events make (pure: same events, same changes). */
  reduce(events: EventIn[]): D[];
}

export interface LedgerStore<D> {
  /** The ledger's saved position (null before its first run). */
  cursor(name: string): Promise<bigint | null>;
  /** Events with these names after the position, oldest first, at most `limit`. */
  events(after: bigint | null, names: string[], limit: number): Promise<EventIn[]>;
  /** Applies the changes and saves the new position together (one transaction). */
  commit(name: string, to: bigint, changes: D[]): Promise<void>;
}

/** Runs one ledger up to the newest stored event; the answer is how many events it read. */
export async function runProjection<D>(p: Projection<D>, store: LedgerStore<D>, batch = 1000): Promise<number> {
  let after = await store.cursor(p.name);
  let read = 0;
  for (;;) {
    const evs = await store.events(after, p.events, batch);
    if (!evs.length) return read;
    const last = evs.at(-1)!;
    const to = position(last.block, last.logIndex);
    await store.commit(p.name, to, p.reduce(evs));
    read += evs.length;
    after = to;
    if (evs.length < batch) return read;
  }
}
