import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NO_ANSWER, runCli, USAGE, type CliDeps } from "../src/teambot/cli";
import { makeBook, type Update } from "../src/teambot/data";
import { createTeambot, inboxDir } from "../src/teambot/runner";
import { loadState, saveState, blankState } from "../src/teambot/state";
import type { Tg } from "../src/teambot/telegram";

const fakeUpdates = (count: number): Update[] =>
  Array.from({ length: count }, (_, i) => ({ n: i + 1, type: "NEW", title: `Sample title ${i + 1}`, status: "VERIFIED", changelog: "", changelog_line: "", telegram: `Telegram text ${i + 1}.`, x: `X text ${i + 1}.` }));
const CONFIG = { repo: "example/cofer", explorer: "https://explorer.example", contracts: [], socials: [], videos: [], health: [] };
const CHAT = -1001234567890;
const TEST_CHAT = -1009999;
const T0 = Date.parse("2026-11-30T18:00:00.000Z");

function setup(o: { count?: number; testChat?: number; missingWide?: number[] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "teambot-cli-"));
  const count = o.count ?? 3;
  for (const shape of ["square", "wide"]) {
    fs.mkdirSync(path.join(dir, "posters", shape), { recursive: true });
    for (let n = 1; n <= count; n++) if (!(shape === "wide" && o.missingWide?.includes(n))) fs.writeFileSync(path.join(dir, "posters", shape, `update-0${n}-${shape}.png`), "png");
  }
  const book = makeBook(fakeUpdates(count), CONFIG, dir);
  const sent: { m: string; chat: number; text: string; file?: string }[] = [];
  const tg = {
    send: async (chat: number, text: string) => (sent.push({ m: "send", chat, text }), 1),
    photo: async (chat: number, file: string, text: string) => (sent.push({ m: "photo", chat, text, file: path.basename(file) }), 2),
  } as unknown as Tg;
  const out: string[] = [];
  const deps: CliDeps = {
    book,
    chat: CHAT,
    testChat: "testChat" in o ? o.testChat : TEST_CHAT,
    tg,
    gate: { githubMode: "check", changelog: async () => "", releases: async () => Array.from({ length: count }, (_, i) => ({ id: i, tag_name: `update-0${i + 1}`, draft: false })) },
    out: (l) => void out.push(l),
    now: () => T0,
    sleep: async () => {},
    by: "ops",
  };
  return { dir, book, sent, out, deps, tg };
}

describe("server commands handed to the running bot", () => {
  test("pause: written to the inbox, applied by the bot, its answer printed", async () => {
    const s = setup();
    const bot = createTeambot({ book: s.book, tg: s.tg, gh: { releases: async () => [], publish: async () => {}, changelog: async () => "" }, chat: CHAT, githubMode: "check", now: () => T0, log: () => {} });
    // the running bot picks the file up on its next tick (here: while the command waits)
    const deps: CliDeps = { ...s.deps, sleep: async () => void (await bot.inboxTick()) };
    expect(await runCli(["pause", "planned", "check"], deps)).toBe(0);
    expect(s.out).toEqual(["Paused."]);
    expect(loadState(s.dir).paused).toMatchObject({ reason: "planned check", by: "ops" });
    expect(fs.readdirSync(inboxDir(s.dir))).toEqual([]);
    expect(s.sent[0]!.text).toStartWith("⏸ <b>PAUSED · updates</b>");
  });

  test("hold passes the number and the reason separately", async () => {
    const s = setup();
    let seen: unknown;
    const deps: CliDeps = {
      ...s.deps,
      sleep: async () => {
        const f = fs.readdirSync(inboxDir(s.dir)).find((x) => x.endsWith(".json"));
        if (!f) return;
        seen = JSON.parse(fs.readFileSync(path.join(inboxDir(s.dir), f), "utf8"));
        saveState(s.dir, { ...blankState(), lastControl: { id: (seen as { id: string }).id, text: "Update 2 is held." } });
      },
    };
    expect(await runCli(["hold", "2", "poster", "fix"], deps)).toBe(0);
    expect(seen).toMatchObject({ cmd: "hold", arg: "2 poster fix", rest: "poster fix", by: "ops" });
    expect(s.out).toEqual(["Update 2 is held."]);
  });

  test("no bot running: says so, removes its file, exit code 1", async () => {
    const s = setup();
    expect(await runCli(["resume"], { ...s.deps, waitTries: 3 })).toBe(1);
    expect(s.out).toEqual([NO_ANSWER]);
    expect(fs.readdirSync(inboxDir(s.dir))).toEqual([]);
  });
});

describe("preflight", () => {
  test("all clear: prints it; --post reports to the staff group", async () => {
    const s = setup();
    expect(await runCli(["preflight"], s.deps)).toBe(0);
    expect(s.out).toEqual(["3 of 3 ready: all clear"]);
    expect(s.sent).toEqual([]);
    await runCli(["preflight", "--post"], s.deps);
    expect(s.sent.map((x) => [x.m, x.chat])).toEqual([["send", CHAT]]);
    expect(s.sent[0]!.text).toStartWith("🟢 <b>PREFLIGHT ALL CLEAR</b>");
  });
  test("something missing: one line per update, and the group report lists them", async () => {
    const s = setup({ missingWide: [2] });
    await runCli(["preflight", "--post"], s.deps);
    expect(s.out).toEqual(["02  The wide poster file is missing on the server.", "2 of 3 ready"]);
    expect(s.sent[0]!.text).toBe("🟡 <b>PREFLIGHT · 2 of 3 ready</b>\n\n<b>02</b> The wide poster file is missing on the server.\n\n<i>Each one is held at its hour unless fixed.</i>");
  });
});

describe("test posts", () => {
  test("the heading and the two posts, sent to the test group only", async () => {
    const s = setup();
    expect(await runCli(["test", "2"], s.deps)).toBe(0);
    expect(s.sent.map((x) => [x.m, x.chat, x.file ?? x.text])).toEqual([
      ["send", TEST_CHAT, "<b>Tech Updates: Update 02 Released</b>"],
      ["photo", TEST_CHAT, "update-02-square.png"],
      ["photo", TEST_CHAT, "update-02-wide.png"],
    ]);
    expect(s.out).toEqual(["Sent update 2's two posts to the test group."]);
  });
  test("no test group, the staff group as test group, or no number: nothing sent", async () => {
    for (const [o, args, line] of [
      [{ testChat: undefined }, ["test", "2"], "Set TEAMBOT_TEST_CHAT_ID first (a test group, never the staff group)."],
      [{ testChat: CHAT }, ["test", "2"], "TEAMBOT_TEST_CHAT_ID is the staff group. Use a separate test group."],
      [{}, ["test", "9"], "Usage: cofer-release test 14"],
    ] as const) {
      const s = setup(o);
      expect(await runCli([...args], s.deps)).toBe(1);
      expect(s.out).toEqual([line]);
      expect(s.sent).toEqual([]);
    }
  });
});

describe("status and usage", () => {
  test("status: the board as plain text, then held reasons", async () => {
    const s = setup();
    saveState(s.dir, { ...blankState(), armedAt: new Date(T0).toISOString(), u: { "2": { state: "held", reason: "The wide poster file is missing on the server." } } });
    expect(await runCli(["status"], s.deps)).toBe(0);
    expect(s.out[0]).toStartWith("COFER LAUNCH BOARD\nLive     0 / 3");
    expect(s.out[0]).toContain("Held    02");
    expect(s.out[1]).toBe("held 02: The wide poster file is missing on the server.");
    expect(s.sent).toEqual([]); // status never posts
  });
  test("unknown command: the usage line, exit code 2; Telegram-only words are not server commands", async () => {
    const s = setup();
    expect(await runCli(["post"], s.deps)).toBe(2);
    expect(await runCli(["run"], s.deps)).toBe(2);
    expect(s.out).toEqual([USAGE, USAGE]);
  });
});
