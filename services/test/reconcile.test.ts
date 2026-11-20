import { describe, expect, test } from "bun:test";
import { differences, reconcile, type PotState } from "../src/keeper/reconcile";
import type { AlertDeps } from "../src/keeper/alerts";

const A = "0x215ea29be890960586cec7e35b381f6599f955aa";
const B = "0x8251fa75f4982cdcb4be015b9f7ba20116a1596c";
const T = "0x14119629e364a53ceda500d0c1111dbb136a7398";
const state = (o: Partial<{ a: bigint; b: bigint; bActive: boolean; total: bigint; bal: bigint }> = {}): PotState => {
  const v = { a: 10n, b: 5n, bActive: true, total: 15n, bal: 100n, ...o };
  return { members: new Map([[A, { active: true, shares: v.a }], [B, { active: v.bActive, shares: v.b }]]), totalShares: v.total, balances: new Map([[T, v.bal]]) };
};

describe("nightly reconciliation", () => {
  test("a clean pass finds nothing", () => {
    expect(differences("P", state(), state())).toEqual([]);
  });

  test("each field's injected mismatch is found and named", () => {
    expect(differences("P", state(), state({ a: 9n, total: 15n }))).toEqual([`P: member ${A} has 10 shares on the chain, 9 in the database`, "P: total shares 15 on the chain, members add up to 14 in the database"]);
    expect(differences("P", state(), state({ bActive: false }))).toEqual([`P: member ${B} is active on the chain, not active in the database`]);
    expect(differences("P", state(), state({ bal: 99n }))).toEqual([`P: token ${T} balance 100 on the chain, 99 in the database`]);
    const missing = state();
    missing.members.delete(B);
    expect(differences("P", state(), missing)).toEqual([`P: member ${B} is on the chain but not in the database`, "P: total shares 15 on the chain, members add up to 10 in the database"]);
  });

  test("the alert carries the first difference and the count, and clears on a clean pass", async () => {
    let dbState = state({ a: 9n });
    const open = new Map<string, string>();
    const sent: string[] = [];
    const alerts: AlertDeps = { open: async (k, t) => (open.has(k) ? false : (open.set(k, t), true)), close: async (k) => { const t = open.get(k) ?? null; open.delete(k); return t; }, send: async (t) => void sent.push(t) };
    const deps = { pots: async () => ["P"], fromChain: async () => state(), fromDb: async () => dbState, alerts };
    expect(await reconcile(deps)).toEqual({ pots: 1, differences: 2 });
    expect(sent[0]).toContain("reconcile-mismatch");
    expect(sent[0]).toContain(`2 difference(s)`);
    dbState = state();
    expect(await reconcile(deps)).toEqual({ pots: 1, differences: 0 });
    expect(open.size).toBe(0);
  });
});
