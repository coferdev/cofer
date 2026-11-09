import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadBook, makeBook, posterPath, roadmapPath, type Book, type Update } from "../src/teambot/data";
import { gate, type GateDeps, type Release } from "../src/teambot/gate";
import {
  allLiveText,
  armedText,
  boardKey,
  boardText,
  changelogReply,
  contractsText,
  currentDay,
  disarmedText,
  healthText,
  heldText,
  incident,
  launchedText,
  nextText,
  pausedText,
  plainText,
  preflightText,
  resumedText,
  roadmapCaption,
  scheduleDay,
  socialsText,
  tgCopy,
  videosText,
  xCopy,
} from "../src/teambot/messages";
import { blankState, dueNow, held, loadState, nextDue, released, saveState, statePath, type State } from "../src/teambot/state";
import { dayLabel, inMins, parseUtc, three, threeShort } from "../src/teambot/time";

// Made-up updates and config, for tests only (the real ones live on the server, never in the repo).
const TYPES = ["NEW", "HOW", "CMD", "BTS"];
function fakeUpdates(count: number): Update[] {
  return Array.from({ length: count }, (_, i) => ({
    n: i + 1,
    type: TYPES[i % 4]!,
    title: `Sample title ${i + 1}`,
    status: "VERIFIED",
    changelog: "",
    changelog_line: "",
    telegram: `Telegram text ${i + 1}.`,
    x: `X text ${i + 1}.`,
  }));
}
const CONFIG = {
  repo: "example/cofer",
  explorer: "https://explorer.example",
  roadmapImage: "kit/roadmap.png",
  contracts: [
    { name: "Factory", address: `0x${"a".repeat(40)}`, sourcify: true },
    { name: "USDG", address: `0x${"b".repeat(40)}` },
  ],
  socials: [{ name: "Website", url: "https://site.example" }],
  videos: [
    { title: "Set up your key", messageId: 10 },
    { title: "Start a group", messageId: 11 },
  ],
  health: [{ name: "Website", url: "https://site.example" }],
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "teambot-core-"));
const book30 = (dir = "/data", updates = fakeUpdates(30)): Book => makeBook(updates, CONFIG, dir);

const LAUNCH = "2026-11-30T18:00:00.000Z";
const T0 = Date.parse(LAUNCH);
const H = 3_600_000;
const armed = (over: Partial<State> = {}): State => ({ ...blankState(), armedAt: LAUNCH, ...over });

describe("times: UTC, Moscow and New York only", () => {
  const d = new Date(LAUNCH);
  test("three zones, long and short", () => {
    expect(three(d)).toBe("18:00 UTC · 21:00 Moscow · 1:00 PM New York");
    expect(threeShort(d)).toBe("18:00 · 21:00 · 1:00 PM");
    expect(three(new Date("2026-12-01T05:30:00Z"))).toBe("05:30 UTC · 08:30 Moscow · 12:30 AM New York");
    expect(dayLabel(d)).toBe("Mon 30 Nov");
  });
  test("midnight UTC is 00:00, not 24:00", () => {
    expect(three(new Date("2026-12-01T00:00:00Z"))).toBe("00:00 UTC · 03:00 Moscow · 7:00 PM New York");
  });
  test("summer time in New York moves the hour", () => {
    expect(three(new Date("2026-07-01T18:00:00Z"))).toBe("18:00 UTC · 21:00 Moscow · 2:00 PM New York");
  });
  test("how long until", () => {
    expect(inMins(d, T0)).toBe("due now");
    expect(inMins(d, T0 - 25 * 60_000)).toBe("in 25 min");
    expect(inMins(d, T0 - 125 * 60_000)).toBe("in 2h 5m");
  });
  test("reading a launch time (UTC)", () => {
    expect(parseUtc("2026-11-30 18:00")?.toISOString()).toBe(LAUNCH);
    expect(parseUtc("2026-11-30T18:00")?.toISOString()).toBe(LAUNCH);
    expect(parseUtc(LAUNCH)?.toISOString()).toBe(LAUNCH);
    expect(parseUtc("30/11/2026 18:00")).toBeNull();
    expect(parseUtc("")).toBeNull();
  });
});

describe("the data folder", () => {
  test("reads updates.json and config.json, sorted by number", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "updates.json"), JSON.stringify(fakeUpdates(3).reverse()));
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(CONFIG));
    const b = loadBook(dir);
    expect(b.total).toBe(3);
    expect(b.updates.map((u) => u.n)).toEqual([1, 2, 3]);
    expect(b.repo).toBe("example/cofer");
    expect(posterPath(b, 7, "wide")).toBe(path.join(dir, "posters", "wide", "update-07-wide.png"));
  });
  test("missing or broken files: a plain message", () => {
    const dir = tmp();
    expect(() => loadBook(dir)).toThrow("updates.json could not be read from the data folder (missing or not readable)");
    fs.writeFileSync(path.join(dir, "updates.json"), "{oops");
    expect(() => loadBook(dir)).toThrow("updates.json could not be read from the data folder (not valid JSON)");
  });
  test("numbers must run 1, 2, 3 with no gaps or repeats", () => {
    const u = fakeUpdates(3);
    expect(() => makeBook([u[0], u[2]], CONFIG, "/d")).toThrow("no gaps");
    expect(() => makeBook([u[0], u[0]], CONFIG, "/d")).toThrow("the same update number twice");
    expect(() => makeBook([], CONFIG, "/d")).toThrow("no updates");
    expect(() => makeBook([{ ...u[0], n: "1" }], CONFIG, "/d")).toThrow("updates.json is not as expected");
    expect(() => makeBook(u, { ...CONFIG, contracts: [{ name: "x", address: "0x12" }] }, "/d")).toThrow("config.json is not as expected");
  });
  test("the roadmap image must be inside the data folder", () => {
    expect(roadmapPath(book30("/data"))).toBe("/data/kit/roadmap.png");
    expect(roadmapPath(makeBook(fakeUpdates(1), { ...CONFIG, roadmapImage: "../../etc/passwd" }, "/data"))).toBeNull();
    expect(roadmapPath(makeBook(fakeUpdates(1), { ...CONFIG, roadmapImage: undefined }, "/data"))).toBeNull();
  });
});

describe("saved state", () => {
  test("blank when there is none; saved and read back; no temporary file left; private to the server user", () => {
    const dir = tmp();
    expect(loadState(dir)).toEqual(blankState());
    const st = armed({ board: 42, offset: 7, u: { "3": { state: "released", tg: 5, x: 6, at: LAUNCH } } });
    saveState(dir, st);
    expect(loadState(dir)).toEqual(st);
    expect(fs.existsSync(`${statePath(dir)}.tmp`)).toBe(false);
    expect(fs.statSync(statePath(dir)).mode & 0o777).toBe(0o600);
  });
  test("a broken state file stops start-up instead of starting over (which could post twice)", () => {
    const dir = tmp();
    fs.writeFileSync(statePath(dir), "{half written");
    expect(() => loadState(dir)).toThrow("state.json in the data folder could not be read");
  });
  test("released, held, next and due", () => {
    const b = book30();
    const st = armed({ u: { "1": { state: "released", at: LAUNCH }, "2": { state: "held" }, "3": { state: "posting" } } });
    expect(released(st, b).map((u) => u.n)).toEqual([1]);
    expect(held(st, b).map((u) => u.n)).toEqual([2]);
    expect(nextDue(st, b)?.n).toBe(3); // one cut off mid-post is still due (its sent posts are remembered)
    expect(dueNow(st, b, T0 + 3 * H).map((u) => u.n)).toEqual([3, 4]);
    expect(dueNow(blankState(), b, T0 + 3 * H)).toEqual([]);
  });
});

describe("incident messages", () => {
  test("the shape: dot, kind, subject, then the rows; users affected defaults to no", () => {
    expect(incident("⏸", "PAUSED", "updates", { what: "a", done: "b", next: "c" })).toBe(
      "⏸ <b>PAUSED · updates</b>\n\n<b>What happened:</b> a\n<b>Users affected:</b> No. Cofer keeps running.\n<b>What we did:</b> b\n<b>Next:</b> c",
    );
  });
  test("HELD and FAILED", () => {
    const b = book30();
    expect(heldText(b.byN.get(15)!, "The wide poster file is missing on the server.", b.byN.get(16))).toBe(
      "🟡 <b>HELD · Update 15</b>\n\n<b>What happened:</b> The wide poster file is missing on the server.\n<b>Users affected:</b> No. Cofer keeps running.\n<b>What we did:</b> Update 15 is held and nothing about it was posted. Update 16 stays on time.\n<b>Next:</b> Fix the above, then on the server run: cofer-release release 15",
    );
    const failed = heldText(b.byN.get(30)!, "GitHub refused to publish the release update-30 (403).", undefined, "FAILED", "🔴");
    expect(failed).toStartWith("🔴 <b>FAILED · Update 30</b>");
    expect(failed).toContain("<b>What we did:</b> Update 30 is held and nothing about it was posted.\n");
  });
  test("reasons are escaped for Telegram HTML", () => {
    expect(heldText(book30().byN.get(1)!, "a <b> & c", undefined)).toContain("a &lt;b&gt; &amp; c");
  });
  test("PAUSED, RESUMED, ARMED, cancelled", () => {
    const b = book30();
    expect(pausedText("planned check")).toContain("<b>What happened:</b> Updates were paused from the server: planned check.");
    // overdue updates go 2 minutes apart
    expect(resumedText(armed(), b, 3)).toContain("<b>Next:</b> 3 overdue updates go out first, 2 minutes apart, then the normal times.");
    expect(resumedText(armed(), b, 1)).toContain("<b>Next:</b> 1 overdue update goes out first, then the normal times.");
    expect(resumedText(armed(), b, 0)).toContain("<b>Next:</b> Update 01 at 18:00 UTC · 21:00 Moscow · 1:00 PM New York.");
    expect(resumedText(blankState(), b, 0)).toContain("<b>Next:</b> Nothing is waiting.");
    expect(resumedText(armed(), b, 0)).toStartWith("▶️ <b>RESUMED · updates</b>");
    expect(armedText(false, new Date(LAUNCH), b)).toBe(
      "🟢 <b>SCHEDULE ARMED</b>\n\n<b>Launch:</b> Mon 30 Nov, 18:00 UTC · 21:00 Moscow · 1:00 PM New York\n30 updates, one every hour. Update 1 goes out at that minute.\nEach update goes out only after its checks pass. One that fails is held, never posted broken.",
    );
    expect(armedText(true, new Date(LAUNCH), b)).toStartWith("🟢 <b>LAUNCH TIME CHANGED</b>");
    expect(disarmedText()).toStartWith("⏸ <b>SCHEDULE CANCELLED · launch</b>");
  });
  test("LAUNCHED and ALL LIVE", () => {
    const b = book30();
    expect(launchedText(armed(), b)).toBe(
      '🟢 <b>COFER IS LAUNCHED</b>\n\nUpdate 1 of 30 is live on Robinhood Chain mainnet.\n\n• GitHub release published: <a href="https://github.com/example/cofer/releases/tag/update-01">update-01</a>\n• The Telegram and X posts follow below.\n\n<b>Next:</b> Update 02 at 19:00 UTC · 22:00 Moscow · 2:00 PM New York, then one every hour until Tue 1 Dec, 23:00 UTC.',
    );
    expect(allLiveText(b, T0 + 29 * H)).toBe(
      '🏁 <b>ALL 30 UPDATES ARE LIVE</b>\n\nThe last one, Update 30, went out at 23:00 UTC · 02:00 Moscow · 6:00 PM New York.\nEvery release: <a href="https://github.com/example/cofer/releases">github.com/example/cofer/releases</a>',
    );
  });
  test("PREFLIGHT", () => {
    const b = book30();
    expect(preflightText([], 30)).toBe(
      "🟢 <b>PREFLIGHT ALL CLEAR</b>\n\n30 of 30 updates are ready: status checked, posters on the server, changelog lines and GitHub releases in place.",
    );
    expect(preflightText([[b.byN.get(4)!, ["A.", "B."]]], 30)).toBe("🟡 <b>PREFLIGHT · 29 of 30 ready</b>\n\n<b>04</b> A. B.\n\n<i>Each one is held at its hour unless fixed.</i>");
  });
});

describe("the two posts", () => {
  test("Telegram: number of total, its text, the GitHub link", () => {
    expect(tgCopy(book30(), book30().byN.get(3)!)).toBe("Update 03 of 30\n\nTelegram text 3.\n\nGitHub: https://github.com/example/cofer/releases/tag/update-03");
  });
  test("X: with its length counted", () => {
    expect(xCopy(book30().byN.get(3)!)).toBe("For X · 20 characters\n\nUpdate 03: X text 3.");
  });
});

describe("the pinned board", () => {
  const b = book30();
  test("not armed", () => {
    expect(boardText(blankState(), b, T0)).toBe(
      "<b>COFER LAUNCH BOARD</b>\n<pre>Live     0 / 30   ▱▱▱▱▱▱▱▱▱▱▱▱\nNext    launch time not set\nQueue   ○ not armed\nHeld    none</pre>\n\n<i>Times: UTC · Moscow · New York. Updated 18:00 UTC.</i>",
    );
  });
  test("armed, before launch", () => {
    const t = boardText(armed(), b, T0 - 90 * 60_000);
    expect(t).toContain("Next    Update 01 · New\n        18:00 · 21:00 · 1:00 PM\n        Mon 30 Nov · in 1h 30m\nQueue   ◷ armed");
  });
  test("running, with a held update and the last release", () => {
    const st = armed({ u: { "1": { state: "released", at: LAUNCH }, "2": { state: "held" }, "3": { state: "released", at: new Date(T0 + 2 * H).toISOString() } } });
    const t = boardText(st, b, T0 + 2 * H + 60_000);
    expect(t).toContain("Live     2 / 30   ▰▱▱▱▱▱▱▱▱▱▱▱");
    expect(t).toContain("Next    Update 04 · Behind the scenes\n        21:00 · 00:00 · 4:00 PM\n        Mon 30 Nov · in 59 min");
    expect(t).toContain("Queue   ● running\nHeld    02</pre>");
    expect(t).toContain('\n<b>Last:</b> Update 03 · Sample title 3\n<a href="https://github.com/example/cofer/releases/tag/update-03">github.com/example/cofer/releases/tag/update-03</a>');
  });
  test("paused and finished", () => {
    expect(boardText(armed({ paused: { reason: "planned check", at: LAUNCH } }), b, T0)).toContain("Queue   ⏸ paused: planned check");
    const all = armed({ u: Object.fromEntries(b.updates.map((u) => [u.n, { state: "released" as const, at: LAUNCH }])) });
    const t = boardText(all, b, T0 + 40 * H);
    expect(t).toContain("Live    30 / 30   ▰▰▰▰▰▰▰▰▰▰▰▰\nQueue   ✓ finished");
  });
  test("the key ignores only the 'Updated' time", () => {
    expect(boardKey(boardText(armed(), b, T0 - 10 * H))).not.toBe(boardKey(boardText(armed(), b, T0 - 9 * H))); // countdown changed
    expect(boardKey(boardText(blankState(), b, T0))).toBe(boardKey(boardText(blankState(), b, T0 + 7 * 60_000)));
  });
  test("plain text for the server", () => {
    expect(plainText(boardText(blankState(), b, T0))).toStartWith("COFER LAUNCH BOARD\nLive     0 / 30");
  });
});

describe("staff-group replies", () => {
  const b = book30();
  test("/schedule: 24 a day, with marks", () => {
    const st = armed({ u: { "1": { state: "released" }, "2": { state: "held" } } });
    const d1 = scheduleDay(st, b, 1)!;
    expect(d1).toStartWith("<b>Day 1 · from Mon 30 Nov</b>\n<i>UTC · Moscow · New York</i>\n\n<code>01✓</code> 18:00 · 21:00 · 1:00 PM  Sample title 1\n<code>02⏸</code> 19:00");
    expect(d1.split("\n").length).toBe(3 + 24);
    expect(scheduleDay(st, b, 2)!).toStartWith("<b>Day 2 · from Tue 1 Dec</b>");
    expect(scheduleDay(st, b, 3)).toBeNull();
    expect(currentDay(st, b, T0 - H)).toBe(1);
    expect(currentDay(st, b, T0 + 25 * H)).toBe(2);
    expect(currentDay(st, b, T0 + 99 * H)).toBe(2);
  });
  test("/next: three not yet out, held marked", () => {
    expect(nextText(blankState(), b, T0)).toBe("The launch time is not set yet.");
    const st = armed({ u: { "1": { state: "released" }, "2": { state: "held" } } });
    expect(nextText(st, b, T0 + H)).toBe(
      "<b>Next updates</b>\n<i>UTC · Moscow · New York</i>\n\n<b>02</b> · Sample title 2\n19:00 · 22:00 · 2:00 PM · due now · ⏸ held\n\n<b>03</b> · Sample title 3\n20:00 · 23:00 · 3:00 PM · in 1h 0m\n\n<b>04</b> · Sample title 4\n21:00 · 00:00 · 4:00 PM · in 2h 0m",
    );
  });
  test("/changelog: latest three", () => {
    expect(changelogReply(blankState(), b)).toBe("Nothing released yet. All releases will be at github.com/example/cofer/releases");
    const st = armed({ u: Object.fromEntries([1, 2, 3, 4].map((n) => [n, { state: "released" as const }])) });
    const t = changelogReply(st, b);
    expect(t).toStartWith('<b>Latest releases</b>\n\n<b>04</b> · Sample title 4\n<a href="https://github.com/example/cofer/releases/tag/update-04">update-04</a>');
    expect(t).not.toContain("<b>01</b>");
  });
  test("/roadmap", () => {
    const st = armed({ u: { "25": { state: "released" } } });
    expect(roadmapCaption(st, b)).toBe(
      "<b>Roadmap</b>\n30 updates, one every hour.\n\n<b>Day 1</b> · updates 1 to 24 · 0 live\n<b>Day 2</b> · updates 25 to 30 · 1 live\n\n/schedule 1 for a full day.",
    );
  });
  test("/contracts, /socials, /videos", () => {
    const c = contractsText(b);
    expect(c).toContain(`<b>Factory</b>\n<code>0x${"a".repeat(40)}</code>\n<a href="https://explorer.example/address/0x${"a".repeat(40)}">explorer</a> · <a href="https://repo.sourcify.dev/4663/0x${"a".repeat(40)}">source verified</a>`);
    expect(c).toContain(`<a href="https://explorer.example/address/0x${"b".repeat(40)}">explorer</a>`);
    expect(socialsText(b)).toBe("<b>Cofer links</b>\n\n<b>Website:</b> https://site.example");
    expect(videosText(b)).toBe("<b>Demo videos</b>\n<i>Desktop, on testnet with test USDG</i>\n\n1. Set up your key\n2. Start a group\n\nSend /video 3 to get one.");
  });
  test("/health", () => {
    expect(healthText([{ name: "Website", status: 200, ok: true, ms: 120 }, { name: "Dashboard" }], armed({ paused: { reason: "x", at: LAUNCH } }), T0)).toBe(
      "<b>Health</b>\n\n✅ Website · 200 · 120 ms\n❌ Dashboard · no answer\n\nUpdates: paused (x)\n<i>Checked 18:00 UTC · 21:00 Moscow · 1:00 PM New York</i>",
    );
  });
});

describe("the gate", () => {
  const b = book30();
  const rel = (n: number, draft = false): Release => ({ id: n, tag_name: `update-${String(n).padStart(2, "0")}`, draft });
  const deps = (over: Partial<GateDeps> = {}): GateDeps => ({
    githubMode: "publish",
    changelog: async () => "## Unreleased\n- Votes say when they run in plain words, on every card, the signer page and the dashboard.\n",
    releases: async () => [rel(1), rel(2, true)],
    posterExists: () => true,
    ...over,
  });

  test("ready: no reasons, and the release is returned (a draft too)", async () => {
    expect(await gate(blankState(), b, b.byN.get(1)!, deps())).toEqual({ why: [], rel: rel(1) });
    expect((await gate(blankState(), b, b.byN.get(2)!, deps())).rel).toEqual(rel(2, true));
  });
  test("every missing piece, as plain sentences", async () => {
    const u: Update = { ...b.byN.get(3)!, status: "RECHECK-LIVE", changelog: "add", changelog_line: "- A line that is not on main yet." };
    const { why, rel: r } = await gate(blankState(), b, u, deps({ posterExists: (p) => p.includes("square") }));
    expect(why).toEqual([
      "It is marked RECHECK-LIVE. Do its one-time check, then run: cofer-release verify 3.",
      "The wide poster file is missing on the server.",
      "Its changelog line is not in CHANGELOG.md on main yet.",
      "The GitHub release update-03 does not exist.",
    ]);
    expect(r).toBeNull();
  });
  test("marked checked from the server passes the status check", async () => {
    const u: Update = { ...b.byN.get(1)!, status: "RECHECK-NUMBERS" };
    expect((await gate({ ...blankState(), u: { "1": { verified: true } } }, b, u, deps())).why).toEqual([]);
  });
  test("the changelog line is found by its start; 'exists' and empty are not checked", async () => {
    const add: Update = { ...b.byN.get(1)!, changelog: "add", changelog_line: "- Votes say when they run in plain words, on every card, the signer page and more words that differ." };
    expect((await gate(blankState(), b, add, deps())).why).toEqual([]);
    let read = false;
    const exists: Update = { ...b.byN.get(1)!, changelog: "exists", changelog_line: "- not on main" };
    await gate(blankState(), b, exists, deps({ changelog: async () => ((read = true), "") }));
    expect(read).toBe(false);
  });
  test("GitHub or the changelog cannot be read: held with that reason", async () => {
    const add: Update = { ...b.byN.get(1)!, changelog: "add", changelog_line: "- x" };
    const { why } = await gate(blankState(), b, add, deps({ changelog: async () => Promise.reject(new Error("CHANGELOG.md could not be read (404)")), releases: async () => Promise.reject(new Error("GitHub releases could not be read (502)")) }));
    expect(why).toEqual(["CHANGELOG.md could not be read (404).", "GitHub releases could not be read (502)."]);
  });
  test("GitHub off: the release is not checked", async () => {
    let asked = false;
    expect(await gate(blankState(), b, b.byN.get(9)!, deps({ githubMode: "off", releases: async () => ((asked = true), []) }))).toEqual({ why: [], rel: null });
    expect(asked).toBe(false);
  });
  test("posters are looked for in the data folder", async () => {
    const seen: string[] = [];
    await gate(blankState(), book30("/srv/teambot"), b.byN.get(5)!, deps({ posterExists: (p) => (seen.push(p), true) }));
    expect(seen).toEqual(["/srv/teambot/posters/square/update-05-square.png", "/srv/teambot/posters/wide/update-05-wide.png"]);
  });
});
