import { describe, expect, test } from "bun:test";
import { compare, rebuild, type LiveTables } from "../scripts/ops/replay";
import type { EventIn } from "../src/indexer/projections/runner";

const POT = "0x362B6794E6374b400aA186C1a67AC2c060af2E50";
const A = "0x215Ea29bE890960586CEc7e35B381F6599f955aa";
const F = "0x5d03d53A5630ceCC545Be46635779094A11E47D7";
const USDG = "0x14119629e364A53ceda500d0c1111DBB136A7398";
const TSTA = "0x3232dDDE4c6a3FE39Fd17696791D50B54Bc52fFE";
let li = 0;
const ev = (block: number, address: string, name: string, args: Record<string, string>): EventIn => ({ block: BigInt(block), logIndex: li++, txHash: `0x${block.toString(16).padStart(64, "0")}`, address, name, args });
const EVENTS = [
  ev(1, POT, "MemberAdded", { member: A }),
  ev(2, POT, "Deposited", { member: A, amount: "100", shares: "100", navBefore: "0" }),
  ev(3, POT, "Exited", { member: A, to: A, shares: "40" }),
  ev(4, POT, "ExitOwed", { asset: TSTA, account: A, amount: "7" }),
  ev(5, POT, "PlanPaid", { months: "1", cost: "9000000" }),
  ev(6, F, "SwapFeeQueued", { bps: "40", eta: "1800000000" }),
];
const clean = (): LiveTables => {
  const r = rebuild(EVENTS, F, USDG);
  return { members: [...r.members.values()], setAsides: [...r.setAsides.values()], admin: r.admin.map((a) => ({ id: a.id, state: a.state })), fees: r.fees.map((f) => ({ id: f.id, amount: f.amount })) };
};

describe("cofer-ops replay", () => {
  test("rebuilds members, set-asides, admin changes and fees from the chain events", () => {
    const r = rebuild(EVENTS, F, USDG);
    expect([...r.members.values()]).toEqual([{ pot: POT, address: A, active: true, shares: 60n }]);
    expect([...r.setAsides.values()][0]!.setAside).toBe(7n);
    expect(r.admin.map((a) => a.state)).toEqual(["queued"]);
    expect(r.fees.map((f) => f.amount)).toEqual([9_000_000n]);
  });

  test("a clean database: no differences", () => {
    expect(compare(rebuild(EVENTS, F, USDG), clean())).toEqual([]);
  });

  test("a known drift in each table is listed", () => {
    const live = clean();
    live.members[0]!.shares = 100n; // the exit was missed
    live.setAsides = [];
    live.admin[0]!.state = "applied";
    live.fees = [];
    live.members.push({ pot: POT, address: "0x00000000000000000000000000000000000000E9", active: true, shares: 1n });
    const d = compare(rebuild(EVENTS, F, USDG), live);
    expect(d).toHaveLength(5);
    expect(d[0]).toBe(`members: ${A} in ${POT} has 100 shares live, 60 rebuilt`);
    expect(d.join("\n")).toContain("is live but no chain event made it");
    expect(d.join("\n")).toContain("set_asides:");
    expect(d.join("\n")).toContain("pending_admin_changes:");
    expect(d.join("\n")).toContain("fees:");
  });

  test("it never writes: the script has no insert, update or delete", async () => {
    const src = await Bun.file(new URL("../scripts/ops/replay.ts", import.meta.url)).text();
    expect(src).not.toMatch(/\.(insert|update|delete)\(|\bexecute\(/);
  });
});
