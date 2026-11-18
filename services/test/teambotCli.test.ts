import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli, USAGE } from "../src/teambot/cli";
import { makeBook } from "../src/teambot/data";
import { blankState, saveState } from "../src/teambot/state";

const cfg = { repo: "coferdev/cofer", explorer: "https://explorer.example", contracts: [], socials: [], videos: [], health: [] };
const ups = (n: number) => Array.from({ length: n }, (_, i) => ({ n: i + 1, type: "NEW", title: `Title ${i + 1}`, status: "PLANNED", telegram: "t", x: "x" }));

function book(st = blankState()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "teambot-cli-"));
  saveState(dir, st);
  return makeBook(ups(3), cfg, dir);
}

describe("the team bot's own server command: read only", () => {
  test("status: the board as plain text, then held updates and open emergencies", () => {
    const st = blankState();
    st.u[2] = { state: "held", reason: "The tests failed." };
    st.alarms["release-tests-failed"] = { name: "release-tests-failed", what: "The tests failed while building Update 02.", who: "Dev fixes it.", openedAt: 0, lastSentAt: 0, ackUntil: 0, messages: [] };
    const out: string[] = [];
    expect(runCli(["status"], { book: book(st), out: (l) => out.push(l), now: () => Date.UTC(2026, 11, 1) })).toBe(0);
    expect(out[0]).toStartWith("COFER LAUNCH");
    expect(out).toContain("held 02: The tests failed.");
    expect(out).toContain("emergency open: release-tests-failed: The tests failed while building Update 02.");
  });

  test("launch commands are not the team bot's: the usage line points at the release system", () => {
    for (const cmd of ["arm", "pause", "hold", "release", "test", "preflight"]) {
      const out: string[] = [];
      expect(runCli([cmd], { book: book(), out: (l) => out.push(l) })).toBe(2);
      expect(out).toEqual([USAGE]);
    }
    expect(runCli([], { book: book(), out: () => {} })).toBe(0);
  });
});
