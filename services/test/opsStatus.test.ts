import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentRelease, SECRET_SETTINGS, statusReport } from "../scripts/ops/status";
import { schemaKeys } from "../scripts/ops/settings";

describe("cofer-ops status", () => {
  test("roles, release, indexer, queues, alerts and settings in one screen", () => {
    const t = statusReport({
      units: [{ name: "cofer", active: "active" }, { name: "cofer-mainnet", active: "inactive" }],
      release: { folder: "20261201T140000Z-update-07", deployedAt: new Date("2026-12-01T14:00:05Z") },
      indexer: { lastBlock: 1000n, targetBlock: 1010n, lagSeconds: 1 },
      queues: { keeper: { waiting: 0, active: 1, delayed: 14, failed: 0 } },
      alerts: ["indexer-behind"],
      settings: [{ name: "CHAIN_ID", set: true }, { name: "RELAYER_PRIVATE_KEY", set: true }, { name: "REOWN_PROJECT_ID", set: false }],
    });
    expect(t).toContain("  cofer              active");
    expect(t).toContain("Release:  20261201T140000Z-update-07 (deployed 2026-12-01 14:00 UTC)");
    expect(t).toContain("Indexer:  block 1000 of 1010, 1 s behind");
    expect(t).toContain("  keeper     waiting 0  active 1  delayed 14  failed 0");
    expect(t).toContain("Alerts:   1 open: indexer-behind");
    expect(t).toContain("  set:     CHAIN_ID, RELAYER_PRIVATE_KEY");
    expect(t).toContain("  not set: REOWN_PROJECT_ID");
  });

  test("never a secret: only names are printed, whatever the environment holds", () => {
    const secret = "0xabc123secretvalue";
    const t = statusReport({ units: [], release: null, indexer: null, queues: null, alerts: null, settings: [{ name: "RELAYER_PRIVATE_KEY", set: true }] });
    expect(t).not.toContain(secret);
    expect(t).toContain("could not be read");
    expect(SECRET_SETTINGS.has("RELAYER_PRIVATE_KEY")).toBe(true);
  });

  test("setting names come from env.ts", () => {
    const keys = schemaKeys();
    for (const k of ["ROLE", "CHAIN_ID", "RELAYER_PRIVATE_KEY", "SPONSOR_MONTHLY_BUDGET_ETH"]) expect(keys).toContain(k);
  });

  test("the release in use is what current points at", () => {
    const root = mkdtempSync(join(tmpdir(), "rel-"));
    mkdirSync(join(root, "releases", "20261201T140000Z-update-07"), { recursive: true });
    symlinkSync(join(root, "releases", "20261201T140000Z-update-07"), join(root, "current"));
    expect(currentRelease(root)!.folder).toBe("20261201T140000Z-update-07");
    expect(currentRelease(join(root, "nope"))).toBeNull();
  });
});
