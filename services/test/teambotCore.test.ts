import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadBook, makeBook, posterPath, roadmapPath, type Book, type Update } from "../src/teambot/data";
import {
  alarmText,
  allLiveText,
  ackText,
  clearedText,
  shippedTodayText,
  statusLineText,
  zipCaption,
  armedText,
  boardKey,
  boardText,
  changelogReply,
  contractsText,
  currentDay,
  disarmedText,
  healthText,
  incident,
  launchText,
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
import { blankState, held, loadState, nextDue, released, saveState, statePath, type State } from "../src/teambot/state";
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
  test("released, held and next", () => {
    const b = book30();
    const st = armed({ u: { "1": { state: "released", at: LAUNCH }, "2": { state: "held" }, "3": { state: "posting" }, "4": { state: "rolled_back" } } });
    expect(released(st, b).map((u) => u.n)).toEqual([1]);
    expect(held(st, b).map((u) => u.n)).toEqual([2, 4]); // rolled back shows as held on the board
    expect(nextDue(st, b)?.n).toBe(3); // one cut off mid-post is still due (its sent posts are remembered)
  });
});

describe("incident messages", () => {
  test("the shape: dot, kind, subject, then the rows; users affected defaults to no", () => {
    expect(incident("⏸", "PAUSED", "updates", { what: "a", done: "b", next: "c" })).toBe(
      "⏸ <b>PAUSED · updates</b>\n\n<b>What happened:</b> a\n<b>Users affected:</b> No. Cofer keeps running.\n<b>What we did:</b> b\n<b>Next:</b> c",
    );
  });
  test("PAUSED, RESUMED, ARMED, cancelled", () => {
    const b = book30();
    expect(pausedText("planned check")).toContain("<b>What happened:</b> Updates were paused from the server: planned check.");
    // overdue updates go 2 minutes apart
    expect(resumedText(armed(), b, 3)).toContain("<b>Next:</b> 3 overdue updates go out first, 2 minutes apart, then the normal times.");
    expect(resumedText(armed(), b, 1)).toContain("<b>Next:</b> 1 overdue update goes out first, then the normal times.");
    expect(resumedText(armed(), b, 0)).toContain("<b>Next:</b> Update 01 at 19:00 UTC · 22:00 Moscow · 2:00 PM New York.");
    expect(resumedText(blankState(), b, 0)).toContain("<b>Next:</b> Nothing is waiting.");
    expect(resumedText(armed(), b, 0)).toStartWith("▶️ <b>RESUMED · updates</b>");
    expect(armedText(false, new Date(LAUNCH), b)).toBe(
      "🟢 <b>SCHEDULE ARMED</b>\n\n<b>Launch:</b> Mon 30 Nov, 18:00 UTC · 21:00 Moscow · 1:00 PM New York\nThe launch announcement goes out at that minute, Update 1 an hour later, then one every hour: 30 updates.\nEach update goes out only after its checks pass. One that fails is held, never posted broken.",
    );
    expect(armedText(true, new Date(LAUNCH), b)).toStartWith("🟢 <b>LAUNCH TIME CHANGED</b>");
    expect(disarmedText()).toStartWith("⏸ <b>SCHEDULE CANCELLED · launch</b>");
  });
  test("the launch announcement and ALL LIVE", () => {
    const b = book30();
    expect(launchText(armed(), b)).toBe(
      "🟢 <b>COFER IS LIVE</b>\n\nCofer is a shared money account for your Telegram group, on Robinhood Chain. Members add USDG, vote on payments with their own key, and anyone can leave with their exact share at any time.\n\nFrom 19:00 UTC · 22:00 Moscow · 2:00 PM New York: one tech update every hour, 30 in all, until Wed 2 Dec, 00:00 UTC. Each one goes out only after it is live and checked.\n\nBot: t.me/coferappbot · getcofer.com",
    );
    expect(launchText(armed(), b).length).toBeLessThan(1024);
    expect(allLiveText(b, T0 + 29 * H)).toBe(
      '🏁 <b>ALL 30 UPDATES ARE LIVE</b>\n\nThe last one, Update 30, went out at 23:00 UTC · 02:00 Moscow · 6:00 PM New York.\nEvery release: <a href="https://github.com/example/cofer/releases">github.com/example/cofer/releases</a>',
    );
  });
  test("PREFLIGHT", () => {
    expect(preflightText([], 30)).toBe(
      "🟢 <b>PREFLIGHT ALL CLEAR</b>\n\n30 of 30 updates are ready: status checked, posters on the server, changelog lines and GitHub releases in place.",
    );
    expect(preflightText([[4, ["A.", "B."]]], 30)).toBe("🟡 <b>PREFLIGHT · 29 of 30 ready</b>\n\n<b>04</b> A. B.\n\n<i>Each one is held at its hour unless fixed.</i>");
  });
});

describe("status lines, zips, emergencies, Shipped today", () => {
  test("the status line: the decided first line, then title, what happened, Next and the link", () => {
    expect(statusLineText("released", 7, "Title & co", "Live on testnet and mainnet.", "Update 08 at 14:00 UTC.", "https://github.com/coferdev/cofer/releases/tag/update-07")).toBe(
      "✅ <b>SHIPPED AND RELEASED · Update 07 · release update-07</b>\nTitle &amp; co\n\nLive on testnet and mainnet.\nNext: Update 08 at 14:00 UTC.\nhttps://github.com/coferdev/cofer/releases/tag/update-07",
    );
    expect(statusLineText("held", 7, "T", "The tests failed.", "x")).toStartWith("🟡 <b>HELD · Update 07 · release update-07</b>");
    expect(statusLineText("delayed", 7, "T", "w", "x")).toStartWith("🟡 <b>RELEASE DELAYED · Update 07 · release update-07</b>");
    expect(statusLineText("rolled_back", 7, "T", "w", "x")).toStartWith("🔴 <b>ROLLED BACK · Update 07 · release update-07</b>");
  });
  test("reasons are escaped for Telegram HTML", () => {
    expect(statusLineText("held", 1, "T", "a <b> & c", "x")).toContain("\na &lt;b&gt; &amp; c\n");
    expect(pausedText("a <b> & c")).toContain("a &lt;b&gt; &amp; c");
    expect(alarmText({ name: "release-tests-failed-01", what: "a <b> & c", who: "d" }, 0)).toContain("What happened: a &lt;b&gt; &amp; c");
  });
  test("zip captions say the poster's exact size", () => {
    expect(zipCaption(7, "square", { w: 1080, h: 1080 })).toBe("Update 07 · square poster, full quality (1080x1080 PNG)");
    expect(zipCaption(7, "wide", null)).toBe("Update 07 · wide poster, full quality");
  });
  test("an emergency: what, which update and when it posts, who acts, how long open, and /ack", () => {
    const a = { name: "release-tests-failed", what: "The tests failed while building Update 07.", who: "Dev fixes it, then on the server: cofer-release release 7.", n: 7, postAt: LAUNCH };
    expect(alarmText(a, 0)).toBe(
      "🔴 <b>ALERT · release-tests-failed</b>\n\nWhat happened: The tests failed while building Update 07.\nUpdate: 07, posting at 18:00 UTC · 21:00 Moscow · 1:00 PM New York\nWho acts: Dev fixes it, then on the server: cofer-release release 7.\n/ack pauses this alarm for 15 minutes.",
    );
    expect(alarmText(a, 4)).toContain("\nStill open after 4m. /ack pauses this alarm for 15 minutes.");
    expect(clearedText("release-tests-failed", "Update 07 is ready")).toBe("🟢 <b>CLEARED · release-tests-failed</b> (Update 07 is ready)");
    expect(ackText("release-tests-failed")).toBe("Paused for 15 minutes: release-tests-failed. It repeats every 2 minutes after that if it is still open.");
  });
  test("Shipped today: the UTC day, the three times, each release with its link", () => {
    expect(shippedTodayText("2026-11-30", [{ n: 1, title: "A", url: "https://github.com/x/y/releases/tag/update-01" }], new Date("2026-11-30T23:55:00Z"))).toBe(
      '<b>Shipped today · 2026-11-30 (UTC)</b>\n23:55 UTC · 02:55 Moscow · 6:55 PM New York\n\n1 update released:\n• Update 01 · A · <a href="https://github.com/x/y/releases/tag/update-01">update-01</a>',
    );
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
      "<b>COFER LAUNCH</b>\n<pre>Live     0 / 30   ▱▱▱▱▱▱▱▱▱▱▱▱\nNext    launch time not set\nQueue   ○ not armed\nHeld    none</pre>\n\n<i>Times: UTC · Moscow · New York. Updated 18:00 UTC.</i>",
    );
  });
  test("armed, before launch", () => {
    const t = boardText(armed(), b, T0 - 90 * 60_000);
    expect(t).toContain("Next    Update 01 · New\n        19:00 · 22:00 · 2:00 PM\n        Mon 30 Nov · in 2h 30m\nQueue   ◷ armed");
  });
  test("running, with a held update and the last release", () => {
    const st = armed({ u: { "1": { state: "released", at: LAUNCH }, "2": { state: "held" }, "3": { state: "released", at: new Date(T0 + 2 * H).toISOString() } } });
    const t = boardText(st, b, T0 + 2 * H + 60_000);
    expect(t).toContain("Live     2 / 30   ▰▱▱▱▱▱▱▱▱▱▱▱");
    expect(t).toContain("Next    Update 04 · Behind the scenes\n        22:00 · 01:00 · 5:00 PM\n        Mon 30 Nov · in 1h 59m");
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
    expect(plainText(boardText(blankState(), b, T0))).toStartWith("COFER LAUNCH\nLive     0 / 30");
  });
  test("the title is COFER LAUNCH, followed by the Live line, in every state", () => {
    const all = armed({ u: Object.fromEntries(b.updates.map((u) => [u.n, { state: "released" as const, at: LAUNCH }])) });
    const states: [string, State, number][] = [
      ["not armed", blankState(), T0],
      ["armed", armed(), T0 - 90 * 60_000],
      ["running, held, last", armed({ u: { "1": { state: "released", at: LAUNCH }, "2": { state: "held" } } }), T0 + H + 60_000],
      ["paused", armed({ paused: { reason: "planned check", at: LAUNCH } }), T0],
      ["finished", all, T0 + 40 * H],
    ];
    for (const [name, st, at] of states) {
      const t = boardText(st, b, at);
      expect(`${name}: ${t.slice(0, 33)}`).toBe(`${name}: <b>COFER LAUNCH</b>\n<pre>Live    `);
      expect(plainText(t).split("\n")[0]).toBe("COFER LAUNCH");
      expect(t).not.toContain("BOARD");
    }
  });
});

describe("staff-group replies", () => {
  const b = book30();
  test("/schedule: 24 a day, with marks", () => {
    const st = armed({ u: { "1": { state: "released" }, "2": { state: "held" } } });
    const d1 = scheduleDay(st, b, 1)!;
    expect(d1).toStartWith("<b>Day 1 · from Mon 30 Nov</b>\n<i>UTC · Moscow · New York</i>\n\n<code>01✓</code> 19:00 · 22:00 · 2:00 PM  Sample title 1\n<code>02⏸</code> 20:00");
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
      "<b>Next updates</b>\n<i>UTC · Moscow · New York</i>\n\n<b>02</b> · Sample title 2\n20:00 · 23:00 · 3:00 PM · in 1h 0m · ⏸ held\n\n<b>03</b> · Sample title 3\n21:00 · 00:00 · 4:00 PM · in 2h 0m\n\n<b>04</b> · Sample title 4\n22:00 · 01:00 · 5:00 PM · in 3h 0m",
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
