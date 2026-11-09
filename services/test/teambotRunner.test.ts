import { describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnv } from "../src/env";
import { makeBook, type Book, type Update } from "../src/teambot/data";
import type { Release } from "../src/teambot/gate";
import { githubClient, type GitHub } from "../src/teambot/github";
import { tgCopy, xCopy } from "../src/teambot/messages";
import { createTeambot, inboxDir, type Teambot } from "../src/teambot/runner";
import { maybeStartTeambot } from "../src/teambot/start";
import { loadState } from "../src/teambot/state";
import { telegramClient, type Tg, type TgUpdate } from "../src/teambot/telegram";

// ---------------- made-up data (never the real updates) ----------------
const TYPES = ["NEW", "HOW", "CMD", "BTS"];
const fakeUpdates = (count: number): Update[] =>
  Array.from({ length: count }, (_, i) => ({ n: i + 1, type: TYPES[i % 4]!, title: `Sample title ${i + 1}`, status: "VERIFIED", changelog: "", changelog_line: "", telegram: `Telegram text ${i + 1}.`, x: `X text ${i + 1}.` }));
const CONFIG = {
  repo: "example/cofer",
  explorer: "https://explorer.example",
  roadmapImage: "kit/roadmap.png",
  contracts: [{ name: "Factory", address: `0x${"a".repeat(40)}`, sourcify: true }],
  socials: [{ name: "Website", url: "https://site.example" }],
  videos: [{ title: "Set up your key", messageId: 10 }],
  health: [{ name: "Website", url: "https://site.example" }],
};
const CHAT = -1001234567890;
const LAUNCH = "2026-11-30T18:00:00.000Z";
const T0 = Date.parse(LAUNCH);
const H = 3_600_000;
const MIN = 60_000;
const rel = (n: number, draft = true): Release => ({ id: 1000 + n, tag_name: `update-${String(n).padStart(2, "0")}`, draft });

function dataDir(count: number, missing: string[] = []): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "teambot-run-"));
  for (const shape of ["square", "wide"]) {
    fs.mkdirSync(path.join(dir, "posters", shape), { recursive: true });
    for (let n = 1; n <= count; n++) {
      const f = `update-${String(n).padStart(2, "0")}-${shape}.png`;
      if (!missing.includes(f)) fs.writeFileSync(path.join(dir, "posters", shape, f), "png");
    }
  }
  return dir;
}

// ---------------- stand-ins ----------------
type Sent = { m: string; chat: number; text?: string; file?: string; html?: boolean; id?: number; from?: number };
function fakeTelegram() {
  const sent: Sent[] = [];
  const queue: TgUpdate[] = [];
  let id = 100;
  const s = { sent, queue, editError: "" as string, failPhoto: "" as string, menu: [] as [string, string][] };
  const tg: Tg = {
    send: async (chat, text) => (sent.push({ m: "send", chat, text, id: ++id }), id),
    photo: async (chat, file, caption, html) => {
      if (s.failPhoto && file.includes(s.failPhoto)) throw new Error("Telegram could not be reached (sendPhoto)");
      sent.push({ m: "photo", chat, file: path.basename(file), text: caption, html: !!html, id: ++id });
      return id;
    },
    edit: async (chat, mid, text) => {
      if (s.editError) throw new Error(s.editError);
      sent.push({ m: "edit", chat, id: mid, text });
    },
    pin: async (chat, mid) => void sent.push({ m: "pin", chat, id: mid }),
    me: async () => "cofer_alerts_bot",
    setCommands: async (_chat, cmds) => void (s.menu = cmds),
    updates: async () => queue.splice(0),
    copy: async (chat, from, mid) => void sent.push({ m: "copy", chat, from, id: mid }),
  };
  return { ...s, s, tg };
}
function fakeGitHub(list: Release[]) {
  const s = { list, published: [] as number[], publishStatus: 0, changelog: "## Unreleased\n" };
  const gh: GitHub = {
    releases: async () => s.list,
    publish: async (id) => {
      if (s.publishStatus) throw Object.assign(new Error(`GitHub refused (${s.publishStatus})`), { status: s.publishStatus });
      s.published.push(id);
      s.list = s.list.map((r) => (r.id === id ? { ...r, draft: false } : r));
    },
    changelog: async () => s.changelog,
  };
  return { s, gh };
}

function setup(o: { count?: number; missing?: string[]; dir?: string; releases?: Release[]; mode?: "publish" | "check" | "off"; health?: typeof fetch } = {}) {
  const count = o.count ?? 4;
  const dir = o.dir ?? dataDir(count, o.missing);
  const book: Book = makeBook(fakeUpdates(count), CONFIG, dir);
  const t = fakeTelegram();
  const g = fakeGitHub(o.releases ?? Array.from({ length: count }, (_, i) => rel(i + 1)));
  const clock = { now: T0 - 2 * H };
  const logs: string[] = [];
  const make = () =>
    createTeambot({ book, tg: t.tg, gh: g.gh, chat: CHAT, githubMode: o.mode ?? "publish", now: () => clock.now, log: (...a) => void logs.push(a.join(" ")), sleep: async () => {}, fetch: o.health });
  const bot = make();
  return { dir, book, t, g, clock, logs, bot, make };
}
const texts = (sent: Sent[]) => sent.filter((x) => x.m === "send").map((x) => x.text!);
async function arm(bot: Teambot, when = "2026-11-30 18:00") {
  return bot.applyControl({ id: "a1", cmd: "arm", arg: when });
}

describe("arming and the hourly release", () => {
  test("arm: ARMED plus the schedule; a time in the past or unreadable is refused", async () => {
    const { bot, t, clock } = setup({ count: 30 });
    expect(await arm(bot, "2026-11-30 17:00")).toBe("Armed for 2026-11-30T17:00:00.000Z (UTC). The schedule was posted in the group.");
    expect(texts(t.sent)[0]).toStartWith("🟢 <b>SCHEDULE ARMED</b>");
    expect(texts(t.sent).slice(1).map((x) => x.split("\n")[0])).toEqual(["<b>Day 1 · from Mon 30 Nov</b>", "<b>Day 2 · from Tue 1 Dec</b>"]);
    expect(await arm(bot)).toBe("Armed for 2026-11-30T18:00:00.000Z (UTC). The schedule was posted in the group.");
    expect(texts(t.sent).at(-3)).toStartWith("🟢 <b>LAUNCH TIME CHANGED</b>");
    clock.now = T0 + H;
    expect(await arm(bot, "2026-11-30 10:00")).toBe("That time has already passed. Pick a time in the future (UTC).");
    expect(await arm(bot, "tomorrow")).toBe('Could not read that time. Use: cofer-release arm "2026-11-30 18:00" (UTC).');
  });

  test("update 1 at its hour: gate, draft published, LAUNCHED, then the two copy-ready posts", async () => {
    const { bot, t, g, clock, book } = setup();
    await arm(bot);
    t.sent.length = 0;
    clock.now = T0 - MIN;
    await bot.releaseTick();
    expect(t.sent).toEqual([]); // not yet
    clock.now = T0;
    await bot.releaseTick();
    expect(g.s.published).toEqual([1001]);
    expect(t.sent.map((x) => x.m)).toEqual(["send", "photo", "photo"]);
    expect(t.sent[0]!.text).toStartWith("🟢 <b>COFER IS LAUNCHED</b>");
    expect(t.sent[1]).toMatchObject({ m: "photo", chat: CHAT, file: "update-01-square.png", text: tgCopy(book, book.byN.get(1)!), html: false });
    expect(t.sent[2]).toMatchObject({ m: "photo", chat: CHAT, file: "update-01-wide.png", text: xCopy(book.byN.get(1)!), html: false });
    expect(bot.st.u[1]!.state).toBe("released");
    // update 2 waits for its own hour
    await bot.releaseTick();
    expect(t.sent).toHaveLength(3);
    clock.now = T0 + H;
    await bot.releaseTick();
    expect(t.sent.slice(3).map((x) => x.file)).toEqual(["update-02-square.png", "update-02-wide.png"]); // no second LAUNCHED
  });

  test("a release that is already published is not published again; GitHub check mode never publishes", async () => {
    const a = setup({ releases: [rel(1, false)] });
    await arm(a.bot);
    a.clock.now = T0;
    await a.bot.releaseTick();
    expect(a.g.s.published).toEqual([]);
    expect(a.bot.st.u[1]!.state).toBe("released");
    const b = setup({ mode: "check" });
    await arm(b.bot);
    b.clock.now = T0;
    await b.bot.releaseTick();
    expect(b.g.s.published).toEqual([]);
    expect(b.bot.st.u[1]!.state).toBe("released");
  });

  test("the last update: ALL LIVE, once", async () => {
    const { bot, t, clock } = setup({ count: 2 });
    await arm(bot);
    clock.now = T0;
    await bot.releaseTick();
    clock.now = T0 + H;
    await bot.releaseTick();
    await bot.releaseTick();
    const live = texts(t.sent).filter((x) => x.startsWith("🏁 <b>ALL 2 UPDATES ARE LIVE</b>"));
    expect(live).toHaveLength(1);
  });
});

describe("restarts never double-post", () => {
  test("a fresh start after a release posts nothing again", async () => {
    const a = setup();
    await arm(a.bot);
    a.clock.now = T0 + 10 * MIN;
    await a.bot.releaseTick();
    const before = a.t.sent.length;
    const again = a.make(); // same data folder: reads state.json
    await again.releaseTick();
    await again.releaseTick();
    expect(a.t.sent.length).toBe(before);
    expect(a.g.s.published).toEqual([1001]);
  });

  test("cut off after the Telegram post: only the X post is sent after the restart, and no second LAUNCHED", async () => {
    const a = setup();
    await arm(a.bot);
    a.t.sent.length = 0;
    a.clock.now = T0;
    a.t.s.failPhoto = "wide";
    // simulate the process dying while sending the wide poster: keep what was saved, drop this bot
    await a.bot.releaseTick().catch(() => {});
    const saved = loadState(a.dir);
    expect(saved.u[1]!.tg).toBeGreaterThan(0);
    // put it back as if the process had died mid-post (instead of being held as failed)
    saved.u[1]!.state = "posting";
    saved.u[1]!.reason = null;
    fs.writeFileSync(path.join(a.dir, "state.json"), JSON.stringify(saved));
    a.t.s.failPhoto = "";
    a.t.sent.length = 0;
    const again = a.make();
    await again.releaseTick();
    expect(a.t.sent.map((x) => [x.m, x.file])).toEqual([["photo", "update-01-wide.png"]]);
    expect(again.st.u[1]!.state).toBe("released");
  });

  test("the board is posted and pinned once, and edited in place after a restart", async () => {
    const a = setup();
    await a.bot.boardTick(true);
    await a.bot.boardTick();
    expect(a.t.sent.map((x) => x.m)).toEqual(["send", "pin"]);
    const boardId = a.t.sent[0]!.id;
    const again = a.make();
    await again.boardTick(true);
    expect(a.t.sent.slice(2)).toMatchObject([{ m: "edit", id: boardId }]);
  });
});

describe("the gate holds an update, and the next stays on time", () => {
  test("missing poster: HELD with the reason, nothing posted, the next goes at its hour; not repeated", async () => {
    const { bot, t, clock } = setup({ missing: ["update-02-wide.png"] });
    await arm(bot);
    clock.now = T0;
    await bot.releaseTick();
    t.sent.length = 0;
    clock.now = T0 + H;
    await bot.releaseTick();
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.text).toBe(
      "🟡 <b>HELD · Update 02</b>\n\n<b>What happened:</b> The wide poster file is missing on the server.\n<b>Users affected:</b> No. Cofer keeps running.\n<b>What we did:</b> Update 02 is held and nothing about it was posted. Update 03 stays on time.\n<b>Next:</b> Fix the above, then on the server run: cofer-release release 2",
    );
    await bot.releaseTick();
    expect(t.sent).toHaveLength(1); // one message per real change
    clock.now = T0 + 2 * H;
    await bot.releaseTick();
    expect(t.sent.slice(1).map((x) => x.file)).toEqual(["update-03-square.png", "update-03-wide.png"]);
    expect(bot.held().map((u) => u.n)).toEqual([2]);
  });

  test("released from the server: its checks run again, then it goes out", async () => {
    const { bot, t, clock, dir } = setup({ missing: ["update-01-wide.png"] });
    await arm(bot);
    clock.now = T0;
    await bot.releaseTick();
    expect(bot.st.u[1]!.state).toBe("held");
    expect(await bot.applyControl({ id: "r1", cmd: "release", arg: "1" })).toBe("Update 1 is no longer held. Its checks run again before it goes out (it is overdue, so it goes out shortly).");
    await bot.releaseTick();
    expect(bot.st.u[1]!.state).toBe("held"); // still missing: held again (a new message, the reason is the same but it was released in between)
    fs.writeFileSync(path.join(dir, "posters", "wide", "update-01-wide.png"), "png");
    await bot.applyControl({ id: "r2", cmd: "release", arg: "1" });
    t.sent.length = 0;
    await bot.releaseTick();
    expect(t.sent.map((x) => x.file ?? x.text!.split("\n")[0])).toEqual(["🟢 <b>COFER IS LAUNCHED</b>", "update-01-square.png", "update-01-wide.png"]);
  });

  test("not VERIFIED until marked checked from the server", async () => {
    const { bot, book, clock } = setup();
    book.byN.get(1)!.status = "RECHECK-LIVE";
    await arm(bot);
    clock.now = T0;
    await bot.releaseTick();
    expect(bot.st.u[1]!.reason).toBe("It is marked RECHECK-LIVE. Do its one-time check, then run: cofer-release verify 1.");
    expect(await bot.applyControl({ id: "v", cmd: "verify", arg: "1" })).toBe("Update 1 is marked as checked.");
    await bot.applyControl({ id: "r", cmd: "release", arg: "1" });
    await bot.releaseTick();
    expect(bot.st.u[1]!.state).toBe("released");
  });

  test("GitHub refuses to publish: FAILED in red, nothing posted", async () => {
    const { bot, t, g, clock } = setup();
    await arm(bot);
    g.s.publishStatus = 403;
    t.sent.length = 0;
    clock.now = T0;
    await bot.releaseTick();
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.text).toStartWith("🔴 <b>FAILED · Update 01</b>\n\n<b>What happened:</b> GitHub refused to publish the release update-01 (403).");
  });

  test("Telegram fails while posting: FAILED with a plain reason", async () => {
    const { bot, t, clock } = setup();
    await arm(bot);
    t.s.failPhoto = "square";
    t.sent.length = 0;
    clock.now = T0;
    await bot.releaseTick();
    expect(texts(t.sent).at(-1)).toStartWith("🔴 <b>FAILED · Update 01</b>\n\n<b>What happened:</b> Telegram could not be reached (sendPhoto).");
  });

  test("hold from the server keeps one back; an update already out cannot be held", async () => {
    const { bot, clock } = setup();
    await arm(bot);
    expect(await bot.applyControl({ id: "h", cmd: "hold", arg: "2 waiting for a fix", rest: "waiting for a fix" })).toBe("Update 2 is held.");
    expect(bot.st.u[2]!.reason).toBe("Held from the server: waiting for a fix.");
    clock.now = T0;
    await bot.releaseTick();
    expect(await bot.applyControl({ id: "h2", cmd: "hold", arg: "1", rest: "" })).toBe("Update 1 is already out.");
    expect(await bot.applyControl({ id: "h3", cmd: "release", arg: "3" })).toBe("Update 3 is not held. Nothing changed.");
  });
});

describe("pause and resume", () => {
  test("PAUSED once; RESUMED only after a PAUSED; overdue updates then go 2 minutes apart", async () => {
    const { bot, t, clock } = setup();
    await arm(bot);
    clock.now = T0 - 30 * MIN;
    t.sent.length = 0;
    expect(await bot.applyControl({ id: "p", cmd: "pause", arg: "planned check" })).toBe("Paused.");
    expect(await bot.applyControl({ id: "p2", cmd: "pause", arg: "again" })).toBe("Already paused (planned check). Nothing changed.");
    expect(texts(t.sent)).toEqual([expect.stringContaining("⏸ <b>PAUSED · updates</b>") as unknown as string]);
    clock.now = T0 + 2 * H + 5 * MIN; // updates 1, 2 and 3 are now overdue
    await bot.releaseTick();
    expect(t.sent).toHaveLength(1); // nothing while paused
    expect(await bot.applyControl({ id: "r", cmd: "resume" })).toBe("Resumed.");
    expect(texts(t.sent).at(-1)).toContain("<b>Next:</b> 3 overdue updates go out first, 2 minutes apart, then the normal times.");
    expect(await bot.applyControl({ id: "r2", cmd: "resume" })).toBe("Not paused. Nothing changed.");
    expect(t.sent).toHaveLength(2); // no second RESUMED
    t.sent.length = 0;
    await bot.releaseTick(); // update 1 (and LAUNCHED)
    clock.now += MIN;
    await bot.releaseTick(); // too soon
    expect(t.sent.filter((x) => x.m === "photo").map((x) => x.file)).toEqual(["update-01-square.png", "update-01-wide.png"]);
    clock.now += MIN;
    await bot.releaseTick(); // 2 minutes later: update 2
    clock.now += 2 * MIN;
    await bot.releaseTick(); // update 3
    expect(t.sent.filter((x) => x.m === "photo").map((x) => x.file)).toEqual(["update-01-square.png", "update-01-wide.png", "update-02-square.png", "update-02-wide.png", "update-03-square.png", "update-03-wide.png"]);
  });

  test("disarm before launch; not after updates went out", async () => {
    const { bot, t, clock } = setup();
    expect(await bot.applyControl({ id: "d", cmd: "disarm" })).toBe("Not armed. Nothing changed.");
    await arm(bot);
    expect(await bot.applyControl({ id: "d2", cmd: "disarm" })).toBe("Disarmed.");
    expect(texts(t.sent).at(-1)).toStartWith("⏸ <b>SCHEDULE CANCELLED · launch</b>");
    await arm(bot);
    clock.now = T0;
    await bot.releaseTick();
    expect(await bot.applyControl({ id: "d3", cmd: "disarm" })).toBe("Updates have already gone out; use pause instead.");
    expect(await arm(bot, "2026-12-30 18:00")).toBe("Updates have already gone out. The launch time can no longer change.");
  });
});

describe("server commands through the inbox", () => {
  test("a command file is applied, answered in state.json and removed; a broken file is removed", async () => {
    const { bot, dir } = setup();
    fs.mkdirSync(inboxDir(dir), { recursive: true });
    fs.writeFileSync(path.join(inboxDir(dir), "1-abc.json"), JSON.stringify({ id: "1-abc", cmd: "pause", arg: "planned check", by: "ops" }));
    fs.writeFileSync(path.join(inboxDir(dir), "2-bad.json"), "{nope");
    fs.writeFileSync(path.join(inboxDir(dir), "3-bad.json"), JSON.stringify({ id: "../../x", cmd: "pause" }));
    await bot.inboxTick();
    expect(fs.readdirSync(inboxDir(dir))).toEqual([]);
    expect(loadState(dir).lastControl).toEqual({ id: "1-abc", text: "Paused." });
    expect(bot.st.paused?.by).toBe("ops");
  });
  test("an unknown command changes nothing", async () => {
    const { bot } = setup();
    expect(await bot.applyControl({ id: "x", cmd: "post" })).toBe("Unknown command: post");
  });
});

describe("the pinned board", () => {
  test("edited only when something changed (or every 5 minutes); a deleted board is posted and pinned again", async () => {
    const { bot, t, clock } = setup();
    await bot.boardTick(true);
    clock.now += MIN;
    await bot.boardTick();
    expect(t.sent.map((x) => x.m)).toEqual(["send", "pin"]);
    clock.now += 5 * MIN;
    await bot.boardTick();
    expect(t.sent.map((x) => x.m)).toEqual(["send", "pin", "edit"]);
    t.s.editError = "Telegram said 400 Bad Request: message to edit not found (editMessageText)";
    await bot.boardTick(true);
    t.s.editError = "";
    expect(t.sent.map((x) => x.m)).toEqual(["send", "pin", "edit", "send", "pin"]);
    expect(bot.st.board).toBe(t.sent.at(-2)!.id!);
  });
  test("'not modified' is fine and posts nothing new", async () => {
    const { bot, t } = setup();
    await bot.boardTick(true);
    t.s.editError = "Telegram said 400 Bad Request: message is not modified (editMessageText)";
    await bot.boardTick(true);
    expect(t.sent.map((x) => x.m)).toEqual(["send", "pin"]);
  });
});

describe("staff-group commands", () => {
  let uid = 1;
  const msg = (text: string, o: { chat?: number; bot?: boolean } = {}): TgUpdate => ({ update_id: uid++, message: { message_id: uid, chat: { id: o.chat ?? CHAT }, from: { is_bot: !!o.bot }, text } });

  test("answered only in the staff group, only our commands, never other bots' or plain chat", async () => {
    const { bot, t } = setup();
    await bot.setup();
    for (const m of [msg("/status", { chat: 555 }), msg("hello team"), msg("/status@other_bot"), msg("/pause"), msg("/status", { bot: true }), msg("/resume")]) await bot.handle(m);
    expect(t.sent).toEqual([]);
    await bot.handle(msg("/status@Cofer_Alerts_Bot"));
    expect(texts(t.sent)[0]).toStartWith("<b>COFER LAUNCH BOARD</b>");
    expect(t.s.menu.map(([c]) => c)).toEqual(["status", "next", "schedule", "poster", "changelog", "roadmap", "contracts", "socials", "videos", "health", "help"]);
    expect(t.s.menu.map(([c]) => c)).not.toContain("pause");
  });

  test("the same command twice in a row is answered once; the read position is saved", async () => {
    const { bot, t, clock, dir } = setup();
    await bot.handle(msg("/help"));
    await bot.handle(msg("/help"));
    expect(t.sent).toHaveLength(1);
    expect(texts(t.sent)[0]).toStartWith("<b>Cofer team bot</b>");
    clock.now += 6000;
    const last = msg("/help");
    await bot.handle(last);
    expect(t.sent).toHaveLength(2);
    expect(loadState(dir).offset).toBe(last.update_id + 1);
  });

  test("pollOnce reads updates from Telegram and answers them", async () => {
    const { bot, t } = setup();
    t.queue.push(msg("/socials"));
    await bot.pollOnce(0);
    expect(texts(t.sent)).toEqual(["<b>Cofer links</b>\n\n<b>Website:</b> https://site.example"]);
  });

  test("/poster, /video, /roadmap, /schedule, /next", async () => {
    const { bot, t, clock, dir } = setup({ count: 30 });
    await bot.handle(msg("/poster 2"));
    await bot.handle(msg("/poster"));
    await bot.handle(msg("/schedule"));
    expect(texts(t.sent)).toEqual(["Update 02 is not live yet. Its posters are shared here at its hour.", "Send it with a number, like /poster 14.", "The launch time is not set yet."]);
    await arm(bot);
    clock.now = T0;
    await bot.releaseTick();
    t.sent.length = 0;
    await bot.handle(msg("/poster 1"));
    expect(t.sent.map((x) => [x.file, x.text])).toEqual([
      ["update-01-square.png", "Update 01 · square, for Telegram and Instagram"],
      ["update-01-wide.png", "Update 01 · wide, for X"],
    ]);
    await bot.handle(msg("/video 1"));
    expect(t.sent.at(-1)).toEqual({ m: "copy", chat: CHAT, from: CHAT, id: 10 });
    await bot.handle(msg("/video 9"));
    expect(texts(t.sent).at(-1)).toBe("Send it with a number from 1 to 1, like /video 3.");
    await bot.handle(msg("/roadmap"));
    expect(texts(t.sent).at(-1)).toStartWith("<b>Roadmap</b>"); // no image yet: text
    fs.mkdirSync(path.join(dir, "kit"));
    fs.writeFileSync(path.join(dir, "kit", "roadmap.png"), "png");
    clock.now += 6000;
    await bot.handle(msg("/roadmap"));
    expect(t.sent.at(-1)).toMatchObject({ m: "photo", file: "roadmap.png", html: true });
    await bot.handle(msg("/schedule 9"));
    expect(texts(t.sent).at(-1)).toBe("There is no day 9. Try /schedule 1.");
    await bot.handle(msg("/schedule 2"));
    expect(texts(t.sent).at(-1)).toStartWith("<b>Day 2 · from Tue 1 Dec</b>");
    await bot.handle(msg("/next"));
    expect(texts(t.sent).at(-1)).toStartWith("<b>Next updates</b>");
    for (const c of ["/changelog", "/contracts", "/videos"]) await bot.handle(msg(c));
    expect(texts(t.sent).slice(-3).map((x) => x.split("\n")[0])).toEqual(["<b>Latest releases</b>", "<b>Cofer contracts</b>", "<b>Demo videos</b>"]);
  });

  test("/health asks each site", async () => {
    const asked: string[] = [];
    const { bot, t } = setup({ health: (async (u: string | URL | Request) => (asked.push(String(u)), new Response("ok", { status: 200 }))) as typeof fetch });
    await bot.handle(msg("/health"));
    expect(asked).toEqual(["https://site.example"]);
    expect(texts(t.sent)[0]).toMatch(/^<b>Health<\/b>\n\n✅ Website · 200 · \d+ ms\n\nUpdates: not armed\n/);
  });
});

// ---------------- the real clients against stand-in servers ----------------
const TOKEN = "7000000001:AAFakeAlertBotTokenSECRETxyz";
function fakeFetch(reply: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return reply(String(url), init);
  }) as typeof fetch;
  return { calls, f };
}
const tgOk = (result: unknown) => Response.json({ ok: true, result });

describe("Telegram client", () => {
  test("messages are HTML with no link previews", async () => {
    const s = fakeFetch(() => tgOk({ message_id: 7, date: 0, chat: { id: CHAT, type: "supergroup" } }));
    expect(await telegramClient(TOKEN, { fetch: s.f }).send(CHAT, "<b>x</b>")).toBe(7);
    expect(s.calls[0]!.url).toEndWith("/sendMessage");
    expect(JSON.parse(String(s.calls[0]!.init!.body))).toMatchObject({ chat_id: CHAT, text: "<b>x</b>", parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  });
  test("photos are uploaded from the data folder", async () => {
    const dir = dataDir(1);
    const s = fakeFetch(() => tgOk({ message_id: 8, date: 0, chat: { id: CHAT, type: "supergroup" } }));
    expect(await telegramClient(TOKEN, { fetch: s.f }).photo(CHAT, path.join(dir, "posters", "wide", "update-01-wide.png"), "caption")).toBe(8);
    expect(s.calls[0]!.url).toEndWith("/sendPhoto");
  });
  test("too many requests: waits as told, then sends", async () => {
    let n = 0;
    const waits: number[] = [];
    const s = fakeFetch(() => (n++ === 0 ? Response.json({ ok: false, error_code: 429, description: "Too Many Requests: retry after 3", parameters: { retry_after: 3 } }, { status: 429 }) : tgOk({ message_id: 9, date: 0, chat: { id: CHAT, type: "supergroup" } })));
    expect(await telegramClient(TOKEN, { fetch: s.f, wait: async (ms) => void waits.push(ms) }).send(CHAT, "x")).toBe(9);
    expect(waits).toEqual([4000]);
  });
  test("errors carry Telegram's reason, never the token", async () => {
    const refuse = fakeFetch(() => Response.json({ ok: false, error_code: 400, description: "Bad Request: message to edit not found" }, { status: 400 }));
    const e1 = await telegramClient(TOKEN, { fetch: refuse.f }).edit(CHAT, 1, "x").catch((e: Error) => e);
    expect((e1 as Error).message).toBe("Telegram said 400 Bad Request: message to edit not found (editMessageText)");
    const down = fakeFetch(() => {
      throw new Error(`connect ECONNREFUSED https://api.telegram.org/bot${TOKEN}/sendMessage`);
    });
    const e2 = await telegramClient(TOKEN, { fetch: down.f, wait: async () => {} }).send(CHAT, "x").catch((e: Error) => e);
    expect((e2 as Error).message).toBe("Telegram could not be reached (sendMessage)");
    expect(`${(e2 as Error).stack}`).not.toContain("SECRET");
    expect(down.calls).toHaveLength(4);
  });
  test("commands are set for the staff group only", async () => {
    const s = fakeFetch(() => tgOk(true));
    await telegramClient(TOKEN, { fetch: s.f }).setCommands(CHAT, [["status", "the launch board"]]);
    expect(JSON.parse(String(s.calls[0]!.init!.body))).toEqual({ commands: [{ command: "status", description: "the launch board" }], scope: { type: "chat", chat_id: CHAT } });
  });
});

describe("GitHub client", () => {
  const GH_TOKEN = "github_pat_FAKESECRET";
  test("reads every release with the token in a header (never the URL), and caches for 30 seconds", async () => {
    let now = 0;
    const s = fakeFetch(() => Response.json([{ id: 1, tag_name: "update-01", draft: true, body: "x" }]));
    const gh = githubClient({ repo: "example/cofer", token: GH_TOKEN, fetch: s.f, now: () => now });
    expect(await gh.releases(false)).toEqual([{ id: 1, tag_name: "update-01", draft: true }]);
    await gh.releases(false);
    expect(s.calls).toHaveLength(1);
    now = 31_000;
    await gh.releases(false);
    await gh.releases(true);
    expect(s.calls).toHaveLength(3);
    expect(s.calls[0]!.url).toBe("https://api.github.com/repos/example/cofer/releases?per_page=100&page=1");
    expect(s.calls.every((c) => !c.url.includes("FAKESECRET"))).toBe(true);
    expect((s.calls[0]!.init!.headers as Record<string, string>).authorization).toBe(`Bearer ${GH_TOKEN}`);
  });
  test("publishing a draft: one PATCH with draft false; a refusal carries the status", async () => {
    const s = fakeFetch((_u, init) => (init?.method === "PATCH" ? Response.json({}) : Response.json([])));
    const gh = githubClient({ repo: "example/cofer", token: GH_TOKEN, fetch: s.f });
    await gh.publish(42);
    expect(s.calls[0]!.url).toBe("https://api.github.com/repos/example/cofer/releases/42");
    expect(s.calls[0]!.init!.method).toBe("PATCH");
    expect(JSON.parse(String(s.calls[0]!.init!.body))).toEqual({ draft: false });
    const no = githubClient({ repo: "example/cofer", token: GH_TOKEN, fetch: fakeFetch(() => new Response("", { status: 403 })).f });
    const e = (await no.publish(42).catch((x: unknown) => x)) as Error & { status?: number };
    expect(e.status).toBe(403);
    expect(e.message).not.toContain("FAKESECRET");
  });
  test("CHANGELOG.md from main; a failure is a plain sentence", async () => {
    const s = fakeFetch(() => new Response("## Unreleased\n- line"));
    expect(await githubClient({ repo: "example/cofer", fetch: s.f }).changelog()).toBe("## Unreleased\n- line");
    expect(s.calls[0]!.url).toBe("https://raw.githubusercontent.com/example/cofer/main/CHANGELOG.md");
    const bad = githubClient({ repo: "example/cofer", fetch: fakeFetch(() => new Response("", { status: 404 })).f });
    expect(await bad.changelog().catch((e: Error) => e.message)).toBe("CHANGELOG.md could not be read (404)");
    const down = githubClient({ repo: "example/cofer", fetch: fakeFetch(() => Promise.reject(new Error("boom"))).f });
    expect(await down.releases(true).catch((e: Error) => e.message)).toBe("GitHub releases could not be read (no answer)");
  });
});

describe("start-up in the keeper", () => {
  const base = {
    PUBLIC_URL: "https://sign.example",
    DATABASE_URL: "postgres://x",
    RHC_RPC_URL: "https://rpc.example",
    FACTORY_ADDRESS: `0x${"1".repeat(40)}`,
    ADAPTER_ADDRESS: `0x${"2".repeat(40)}`,
    RELAYER_PRIVATE_KEY: "0x01",
    TELEGRAM_BOT_TOKEN: "t",
    TELEGRAM_BOT_USERNAME: "b",
    TELEGRAM_WEBHOOK_SECRET: "s".repeat(16),
    LINK_SECRET: "l".repeat(32),
    ALERT_BOT_TOKEN: TOKEN,
    OPS_CHAT_ID: String(CHAT),
  };
  test("off (the testnet default): not started, nothing logged", () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(maybeStartTeambot(parseEnv({ ...base, CHAIN_ID: "46630" }))).toBeNull();
      expect(err).not.toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });
  test("switched on for testnet by mistake: not started, the reason logged without the token", () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(maybeStartTeambot(parseEnv({ ...base, CHAIN_ID: "46630", TEAMBOT_ENABLED: "1", TEAMBOT_DATA_DIR: dataDir(1), TEAMBOT_GITHUB_MODE: "off" }))).toBeNull();
      const out = err.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(out).toContain("not started: The team bot runs on mainnet (4663) only; CHAIN_ID is 46630.");
      expect(out).not.toContain("SECRET");
    } finally {
      err.mockRestore();
    }
  });
  test("mainnet with a data folder missing its files: not started, the reason logged, no throw", () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(maybeStartTeambot(parseEnv({ ...base, TEAMBOT_ENABLED: "1", TEAMBOT_DATA_DIR: dataDir(1), TEAMBOT_GITHUB_MODE: "off" }))).toBeNull();
      expect(err.mock.calls.map((c) => c.join(" ")).join("\n")).toContain("not started: updates.json could not be read from the data folder");
    } finally {
      err.mockRestore();
    }
  });
});
