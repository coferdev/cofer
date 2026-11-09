import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { alertText, EMERGENCY_REMIND_EVERY_SEC, WHO } from "../src/core/alertFormat";
import { remindEmergencies, type ReminderDeps } from "../src/keeper/keeper";

const T0 = 1_800_000_000;
const MIN = 60;
const EMERGENCY = alertText({ name: "role-changed", what: "The guardian was changed to 0x0000…0bad.", who: WHO.emergency, emergency: true });
const NORMAL = alertText({ name: "indexer-behind", what: "The indexer is 12m behind.", who: WHO.dev });

/** The alerts table in memory: key -> text, opened and last sent (unix seconds). */
function fake(rows: Record<string, { text: string; opened: number; last: number }>, failSend = false) {
  const sent: string[] = [];
  let clock = T0;
  const deps: ReminderDeps = {
    due: async (cutoff) =>
      Object.entries(rows)
        .filter(([, r]) => r.last * 1000 <= cutoff.getTime())
        .map(([key, r]) => ({ key, text: r.text, openedAt: new Date(r.opened * 1000) })),
    touch: async (key, at) => {
      if (rows[key]) rows[key]!.last = Math.floor(at.getTime() / 1000);
    },
    send: async (t) => {
      if (failSend) throw new Error("down");
      sent.push(t);
    },
    now: () => clock,
  };
  return { deps, sent, tick: (sec: number) => void (clock += sec) };
}

describe("emergency reminders", () => {
  test("the setting: every 30 minutes at most", () => {
    expect(EMERGENCY_REMIND_EVERY_SEC).toBe(30 * MIN);
  });

  test("an open emergency is posted again after 30 minutes, then not before another 30", async () => {
    const f = fake({ "roles-drift": { text: EMERGENCY, opened: T0, last: T0 } });
    for (let i = 0; i < 6; i++) {
      f.tick(5 * MIN); // the keeper's ops job runs every 5 minutes
      await remindEmergencies(f.deps);
    }
    expect(f.sent).toEqual(["🔴 ALERT · role-changed\nStill open after 30m.\n\nWhat happened: The guardian was changed to 0x0000…0bad.\nWho acts: Tell the owner and the dev at once."]);
    for (let i = 0; i < 6; i++) {
      f.tick(5 * MIN);
      await remindEmergencies(f.deps);
    }
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1]).toContain("Still open after 60m.");
  });

  test("other alerts are never repeated", async () => {
    const f = fake({ "indexer-behind": { text: NORMAL, opened: T0, last: T0 } });
    f.tick(3 * 3600);
    expect(await remindEmergencies(f.deps)).toBe(0);
    expect(f.sent).toEqual([]);
  });

  test("a failed reminder is tried again on the next run", async () => {
    const rows = { "roles-drift": { text: EMERGENCY, opened: T0, last: T0 } };
    const down = fake(rows, true);
    down.tick(31 * MIN);
    const orig = console.error;
    console.error = () => {};
    try {
      expect(await remindEmergencies(down.deps)).toBe(0);
    } finally {
      console.error = orig;
    }
    expect(rows["roles-drift"].last).toBe(T0);
    const up = fake(rows);
    up.tick(36 * MIN);
    expect(await remindEmergencies(up.deps)).toBe(1);
  });

  test("runs in the keeper's 5-minute ops job; the migration only adds the column", () => {
    const keeper = readFileSync(join(import.meta.dir, "..", "src", "keeper", "keeper.ts"), "utf8");
    expect(keeper).toContain("emergencyReminders: () => remindEmergencies(),");
    const sql = readFileSync(join(import.meta.dir, "..", "drizzle", "0003_alerts_last_sent.sql"), "utf8");
    expect(sql.trim()).toBe('ALTER TABLE "alerts" ADD COLUMN "last_sent_at" timestamp with time zone DEFAULT now() NOT NULL;');
  });
});
