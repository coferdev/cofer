import { describe, expect, test } from "bun:test";
import { setAsideAlarm, setAsideKey, type SetAsideAlarmDeps, type SetAsideRow } from "../src/keeper/setAsideAlarm";
import type { AlertDeps } from "../src/keeper/alerts";

const NOW = 1_800_000_000;
const POT = "0x50F19AdD1EE10AF538C1F8bE5bcbA4011F100115";
const TSTA = "0x3232dDDE4c6a3FE39Fd17696791D50B54Bc52fFE";
const ACC = "0x00000000000000000000000000000000000000F1";

function world(o: { open: bigint; ageDays: number; claimable: boolean }) {
  const open = new Map<string, string>();
  const sent: string[] = [];
  const alerts: AlertDeps = {
    open: async (k, t) => (open.has(k) ? false : (open.set(k, t), true)),
    close: async (k) => {
      const t = open.get(k) ?? null;
      open.delete(k);
      return t;
    },
    send: async (t) => void sent.push(t),
  };
  const row: SetAsideRow = { pot: POT, asset: TSTA, account: ACC, open: o.open, lastBlock: 100n };
  const deps = (): SetAsideAlarmDeps => ({
    rows: async () => [row],
    blockTime: async () => NOW - o.ageDays * 86_400,
    claimWouldWork: async () => o.claimable,
    token: async () => ({ symbol: "TSTA", decimals: 18 }),
    now: () => NOW,
    alerts,
  });
  return { deps, open, sent, row, o };
}

describe("set-aside token alarm", () => {
  test("opens once when a token waited over 7 days and its claim would now go through", async () => {
    const w = world({ open: 2n * 10n ** 17n, ageDays: 8, claimable: true });
    expect(await setAsideAlarm(w.deps())).toEqual({ open: 1, cleared: 0 });
    expect(await setAsideAlarm(w.deps())).toEqual({ open: 0, cleared: 0 }); // already open: posted once
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]).toContain("set-aside-waiting");
    expect(w.open.has(setAsideKey(w.row))).toBe(true);
  });

  test("clears when claimed", async () => {
    const w = world({ open: 2n * 10n ** 17n, ageDays: 8, claimable: true });
    await setAsideAlarm(w.deps());
    w.row.open = 0n;
    expect(await setAsideAlarm(w.deps())).toEqual({ open: 0, cleared: 1 });
    expect(w.open.size).toBe(0);
  });

  test("not yet 7 days, or a claim that would still fail: no alert", async () => {
    expect(await setAsideAlarm(world({ open: 1n, ageDays: 6, claimable: true }).deps())).toEqual({ open: 0, cleared: 0 });
    expect(await setAsideAlarm(world({ open: 1n, ageDays: 30, claimable: false }).deps())).toEqual({ open: 0, cleared: 0 });
  });
});
