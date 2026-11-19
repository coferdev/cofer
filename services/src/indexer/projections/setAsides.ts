/**
 * The set-aside ledger (table set_asides): every token set aside during an exit (ExitOwed) and every claim of it
 * (OwedClaimed), per group account, token and recipient. The recipient is the exit's destination, which need not be
 * a member, so these are the ones /claim and the dashboard cannot show. Open = set aside - claimed, the same figure
 * as the group account's owed(token, recipient).
 */
import type { EventIn, Projection } from "./runner";

export interface SetAsideChange {
  pot: string;
  asset: string;
  account: string;
  setAside: bigint;
  claimed: bigint;
  lastBlock: bigint;
}

const key = (c: Pick<SetAsideChange, "pot" | "asset" | "account">) => `${c.pot.toLowerCase()}|${c.asset.toLowerCase()}|${c.account.toLowerCase()}`;

export const setAsidesProjection: Projection<SetAsideChange> = {
  name: "ledger:set_asides",
  events: ["ExitOwed", "OwedClaimed"],
  reduce(events: EventIn[]): SetAsideChange[] {
    const out = new Map<string, SetAsideChange>();
    for (const e of events) {
      const a = e.args as { asset: string; account: string; amount: string | number | bigint };
      const c = { pot: e.address, asset: a.asset, account: a.account, setAside: 0n, claimed: 0n, lastBlock: e.block };
      const k = key(c);
      const cur = out.get(k) ?? c;
      if (e.name === "ExitOwed") cur.setAside += BigInt(a.amount);
      else cur.claimed += BigInt(a.amount);
      cur.lastBlock = e.block;
      out.set(k, cur);
    }
    return [...out.values()];
  },
};

/** Applies changes to an in-memory ledger (used by tests and by the replay tool). */
export function applySetAsides(ledger: Map<string, SetAsideChange>, changes: SetAsideChange[]): Map<string, SetAsideChange> {
  for (const c of changes) {
    const k = key(c);
    const cur = ledger.get(k) ?? { ...c, setAside: 0n, claimed: 0n };
    ledger.set(k, { ...cur, setAside: cur.setAside + c.setAside, claimed: cur.claimed + c.claimed, lastBlock: c.lastBlock > cur.lastBlock ? c.lastBlock : cur.lastBlock });
  }
  return ledger;
}
