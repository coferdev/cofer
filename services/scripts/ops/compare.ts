/**
 * Compares your own observe-only index (docs/ops/run-your-own-indexer.md) with Cofer's public API for one group
 * account: the members' shares rebuilt from your own stored chain events against /v1/pots/:pot/members, and your
 * events against /v1/pots/:pot/timeline. Read-only on both sides.
 *   bun scripts/ops/compare.ts --pot 0x… --api https://<signer site>
 */
import { getAddress } from "viem";
import { replayMembers } from "./replay";
import type { EventIn } from "../../src/indexer/projections/runner";

export interface ApiView {
  members: { address: string; active: boolean; shares: string }[];
  timeline: { block: string; logIndex: number; txHash: string; event: string }[];
}

export function compareWithApi(pot: string, mine: EventIn[], api: ApiView): string[] {
  const out: string[] = [];
  const own = [...replayMembers(mine.filter((e) => e.address.toLowerCase() === pot.toLowerCase())).values()];
  const theirs = new Map(api.members.map((m) => [m.address.toLowerCase(), m]));
  for (const m of own) {
    const t = theirs.get(m.address.toLowerCase());
    if (!t) out.push(`member ${m.address}: in your index, not in the API`);
    else if (BigInt(t.shares) !== m.shares || t.active !== m.active) out.push(`member ${m.address}: your index ${m.shares} shares (${m.active ? "active" : "not active"}), the API ${t.shares} (${t.active ? "active" : "not active"})`);
  }
  for (const t of api.members) if (!own.some((m) => m.address.toLowerCase() === t.address.toLowerCase())) out.push(`member ${t.address}: in the API, not in your index`);
  const key = (b: string | bigint, li: number) => `${b}:${li}`;
  const mineKeys = new Set(mine.filter((e) => e.address.toLowerCase() === pot.toLowerCase()).map((e) => key(e.block, e.logIndex)));
  for (const t of api.timeline) if (!mineKeys.has(key(t.block, t.logIndex))) out.push(`event ${t.event} at block ${t.block} (log ${t.logIndex}): in the API, not in your index`);
  return out;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (k: string) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const pot = getAddress(flag("pot") ?? "");
  const api = (flag("api") ?? "").replace(/\/$/, "");
  const { db, schema } = await import("../../src/db/client");
  const { eq } = await import("drizzle-orm");
  const rows = await db().select().from(schema.chainEvents).where(eq(schema.chainEvents.address, pot));
  const mine: EventIn[] = rows.map((r) => ({ block: r.block, logIndex: r.logIndex, txHash: r.txHash, address: r.address, name: r.name, args: r.args as Record<string, unknown> }));
  const members: ApiView["members"] = [];
  for (let after = ""; ; ) {
    const j = (await (await fetch(`${api}/v1/pots/${pot}/members?limit=200${after ? `&after=${after}` : ""}`)).json()) as { data: { members: ApiView["members"]; next: string | null } };
    members.push(...j.data.members);
    if (!j.data.next) break;
    after = j.data.next;
  }
  const timeline: ApiView["timeline"] = [];
  for (let after = ""; ; ) {
    const j = (await (await fetch(`${api}/v1/pots/${pot}/timeline?limit=200${after ? `&after=${after}` : ""}`)).json()) as { data: { events: ApiView["timeline"]; next: string | null } };
    timeline.push(...j.data.events);
    if (!j.data.next) break;
    after = j.data.next;
  }
  const diffs = compareWithApi(pot, mine, { members, timeline });
  console.log(diffs.length ? `${diffs.length} difference(s):\n${diffs.map((d) => `  ${d}`).join("\n")}` : `Your index and Cofer's API agree for ${pot}: ${members.length} member(s), ${timeline.length} event(s).`);
  process.exit(diffs.length ? 1 : 0);
}
