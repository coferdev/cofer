/**
 * cofer-ops replay: rebuilds every record that comes from chain events (members' shares and active flags, and the
 * ledgers: set-asides, pending admin changes, fees) from the stored chain_events into a scratch copy in memory, then
 * lists every difference from the live tables. It only reads: the live tables are never written.
 *   cofer-ops replay [--pot <address>]
 */
import { getAddress } from "viem";
import { applySetAsides, setAsidesProjection, type SetAsideChange } from "../../src/indexer/projections/setAsides";
import { adminQueueProjection, applyAdminOps, type AdminRow } from "../../src/indexer/projections/adminQueue";
import { feesProjection, type FeeRow } from "../../src/indexer/projections/fees";
import type { EventIn } from "../../src/indexer/projections/runner";

export interface MemberRec {
  pot: string;
  address: string;
  active: boolean;
  shares: bigint;
}

/** Members as the indexer builds them (indexer.ts): added = active, removed = inactive with no shares, deposits and exits move shares. */
export function replayMembers(events: EventIn[]): Map<string, MemberRec> {
  const m = new Map<string, MemberRec>();
  const k = (pot: string, a: string) => `${pot.toLowerCase()}|${a.toLowerCase()}`;
  for (const e of events) {
    const who = String((e.args as { member?: string }).member ?? "");
    if (!who) continue;
    const key = k(e.address, who);
    const cur = m.get(key) ?? { pot: getAddress(e.address), address: getAddress(who), active: false, shares: 0n };
    if (e.name === "MemberAdded") cur.active = true;
    else if (e.name === "MemberRemoved") Object.assign(cur, { active: false, shares: 0n });
    else if (e.name === "Deposited") cur.shares += BigInt(e.args.shares as string);
    else if (e.name === "Exited") cur.shares -= BigInt(e.args.shares as string);
    else continue;
    m.set(key, cur);
  }
  return m;
}

export interface Rebuilt {
  members: Map<string, MemberRec>;
  setAsides: Map<string, SetAsideChange>;
  admin: AdminRow[];
  fees: FeeRow[];
}

export function rebuild(events: EventIn[], factory: string, usdg: string): Rebuilt {
  const sorted = [...events].sort((a, b) => (a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1));
  const only = (names: string[]) => sorted.filter((e) => names.includes(e.name));
  const admin = adminQueueProjection(factory);
  const fees = feesProjection(usdg);
  return {
    members: replayMembers(only(["MemberAdded", "MemberRemoved", "Deposited", "Exited"])),
    setAsides: applySetAsides(new Map(), setAsidesProjection.reduce(only(setAsidesProjection.events))),
    admin: applyAdminOps([], admin.reduce(only(admin.events))),
    fees: fees.reduce(only(fees.events)),
  };
}

export interface LiveTables {
  members: MemberRec[];
  setAsides: SetAsideChange[];
  admin: { id: string; state: string }[];
  fees: { id: string; amount: bigint }[];
}

/** Every difference between the rebuilt copy and the live tables, as plain lines. */
export function compare(r: Rebuilt, live: LiveTables): string[] {
  const out: string[] = [];
  const lm = new Map(live.members.map((x) => [`${x.pot.toLowerCase()}|${x.address.toLowerCase()}`, x]));
  for (const [k, x] of r.members) {
    const l = lm.get(k);
    if (!l) out.push(`members: ${x.address} in ${x.pot} is missing from the live table`);
    else {
      if (l.shares !== x.shares) out.push(`members: ${x.address} in ${x.pot} has ${l.shares} shares live, ${x.shares} rebuilt`);
      if (l.active !== x.active) out.push(`members: ${x.address} in ${x.pot} is ${l.active ? "active" : "not active"} live, ${x.active ? "active" : "not active"} rebuilt`);
    }
  }
  for (const [k, l] of lm) if (!r.members.has(k)) out.push(`members: ${l.address} in ${l.pot} is live but no chain event made it`);
  const ls = new Map(live.setAsides.map((x) => [`${x.pot.toLowerCase()}|${x.asset.toLowerCase()}|${x.account.toLowerCase()}`, x]));
  for (const [k, x] of r.setAsides) {
    const l = ls.get(k);
    if (!l || l.setAside !== x.setAside || l.claimed !== x.claimed) out.push(`set_asides: ${k} is ${l ? `${l.setAside}/${l.claimed}` : "missing"} live, ${x.setAside}/${x.claimed} rebuilt`);
  }
  const la = new Map(live.admin.map((x) => [x.id, x.state]));
  for (const a of r.admin) if (la.get(a.id) !== a.state) out.push(`pending_admin_changes: ${a.id} is ${la.get(a.id) ?? "missing"} live, ${a.state} rebuilt`);
  const lf = new Map(live.fees.map((x) => [x.id, x.amount]));
  for (const f of r.fees) if (lf.get(f.id) !== f.amount) out.push(`fees: ${f.id} is ${lf.get(f.id) ?? "missing"} live, ${f.amount} rebuilt`);
  return out;
}

if (import.meta.main) {
  const { db, schema } = await import("../../src/db/client");
  const { env } = await import("../../src/env");
  const rows = await db().select().from(schema.chainEvents);
  const events: EventIn[] = rows.map((r) => ({ block: r.block, logIndex: r.logIndex, txHash: r.txHash, address: r.address, name: r.name, args: r.args as Record<string, unknown> }));
  const r = rebuild(events, env().FACTORY_ADDRESS, env().USDG_ADDRESS);
  const live: LiveTables = {
    members: (await db().select().from(schema.members)).map((m) => ({ pot: m.pot, address: m.address, active: m.active, shares: BigInt(m.shares) })),
    setAsides: (await db().select().from(schema.setAsides)).map((x) => ({ pot: x.pot, asset: x.asset, account: x.account, setAside: BigInt(x.setAside), claimed: BigInt(x.claimed), lastBlock: x.lastBlock })),
    admin: await db().select({ id: schema.pendingAdminChanges.id, state: schema.pendingAdminChanges.state }).from(schema.pendingAdminChanges),
    fees: (await db().select({ id: schema.fees.id, amount: schema.fees.amount }).from(schema.fees)).map((f) => ({ id: f.id, amount: BigInt(f.amount) })),
  };
  const diffs = compare(r, live);
  console.log(`Rebuilt from ${events.length} stored chain events (scratch copy in memory; live tables untouched).`);
  console.log(diffs.length ? `${diffs.length} difference(s):\n${diffs.map((d) => `  ${d}`).join("\n")}` : "No differences: every live record matches the chain events.");
  process.exit(diffs.length ? 1 : 0);
}
