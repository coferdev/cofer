import { describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnv } from "../src/env";
import { makeBook, type Book, type Update } from "../src/teambot/data";
import { REPLY_ONLY, headingText, plainText, tgCopy, xCopy } from "../src/teambot/messages";
import { ACK_PAUSE_MS, ALARM_REPEAT_MS, BOARD_POSTER_AFTER_MS, createTeambot, heartbeatPath, inboxDir, RETRY_MS, SAME_REPLY_MS, TEST_LABEL, type Labels, type Teambot } from "../src/teambot/runner";
import { maybeStartTeambot } from "../src/teambot/start";
import { loadState } from "../src/teambot/state";
import { telegramClient, type Tg, type TgUpdate } from "../src/teambot/telegram";

// ---------------- made-up data (never the real updates) ----------------
const TYPES = ["NEW", "HOW", "CMD", "BTS"];
const fakeUpdates = (count: number): Update[] =>
  Array.from({ length: count }, (_, i) => ({ n: i + 1, type: TYPES[i % 4]!, title: `Sample title ${i + 1}`, status: "PLANNED", changelog: "", changelog_line: "", telegram: `Telegram text ${i + 1}.`, x: `X text ${i + 1}.` }));
const CONFIG = {
  repo: "example/cofer",
  explorer: "https://explorer.example",
  roadmapImage: "kit/roadmap.png",
  contracts: [{ name: "Factory", address: `0x${"a".repeat(40)}`, sourcify: true }],
  socials: [{ name: "Website", url: "https://site.example" }],
  videos: [{ title: "Set up your key", messageId: 10 }],
  health: [{ name: "Website", url: "https://site.example" }],
};
const CHAT = -1001234567890; // staff group
const ALERT = -1009999; // Alert Test
const LAUNCH = "2026-11-30T18:00:00.000Z";
const T0 = Date.parse(LAUNCH);
const H = 3_600_000;
const MIN = 60_000;

/** A PNG header of the given size, then some bytes (enough for the size and the byte-for-byte zip). */
function png(w: number, h: number, tagByte: number): Uint8Array {
  const b = new Uint8Array(40);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(b.buffer);
  v.setUint32(16, w);
  v.setUint32(20, h);
  b.fill(tagByte, 30);
  return b;
}

function dataDir(count: number, missing: string[] = []): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "teambot-run-"));
  for (const shape of ["square", "wide"] as const) {
    fs.mkdirSync(path.join(dir, "posters", shape), { recursive: true });
    for (let n = 1; n <= count; n++) {
      const f = `update-${String(n).padStart(2, "0")}-${shape}.png`;
      if (!missing.includes(f)) fs.writeFileSync(path.join(dir, "posters", shape, f), shape === "square" ? png(1080, 1080, n) : png(1200, 675, n));
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
  const s = { sent, queue, editError: "" as string, fail: new Set<string>(), menu: [] as [string, string][] };
  const maybeFail = (m: string, file = "") => {
    for (const f of s.fail) if (f === m || (file && file.includes(f))) throw new Error(`Telegram could not be reached (${m})`);
  };
  const tg: Tg = {
    send: async (chat, text) => (maybeFail("sendMessage"), sent.push({ m: "send", chat, text, id: ++id }), id),
    photo: async (chat, file, caption, html) => {
      maybeFail("sendPhoto", file);
      sent.push({ m: "photo", chat, file: path.basename(file), text: caption, html: !!html, id: ++id });
      return id;
    },
    document: async (chat, file, caption) => {
      maybeFail("sendDocument", file);
      sent.push({ m: "doc", chat, file: path.basename(file), text: caption, id: ++id });
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

function setup(o: { count?: number; missing?: string[]; dir?: string; health?: typeof fetch; labels?: Labels; releaseHeartbeat?: string } = {}) {
  const count = o.count ?? 4;
  const dir = o.dir ?? dataDir(count, o.missing);
  const book: Book = makeBook(fakeUpdates(count), CONFIG, dir);
  const t = fakeTelegram();
  const clock = { now: T0 - 2 * H };
  const logs: string[] = [];
  const make = () =>
    createTeambot({ book, tg: t.tg, chat: CHAT, alertChat: ALERT, releaseHeartbeat: o.releaseHeartbeat, labels: o.labels, now: () => clock.now, log: (...a) => void logs.push(a.join(" ")), sleep: async () => {}, fetch: o.health });
  const bot = make();
  return { dir, book, t, clock, logs, bot, make };
}
const texts = (sent: Sent[]) => sent.filter((x) => x.m === "send").map((x) => x.text!);

/** Writes one notice into the team bot's inbox, as the release system does. */
let nid = 0;
function notice(dir: string, body: Record<string, unknown>, id = `n${++nid}`): string {
  const d = inboxDir(dir);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${String(++nid).padStart(6, "0")}-${id}.json`), JSON.stringify({ id, kind: "notice", ...body }));
  return id;
}
async function armed(bot: Teambot, dir: string, at = LAUNCH) {
  notice(dir, { type: "armed", at });
  await bot.inboxTick();
}
async function releaseIt(bot: Teambot, dir: string, n: number, id?: string) {
  notice(dir, { type: "released", n, what: "Live on testnet and mainnet; live checks pass; public commit and release published.", next: `Update ${String(n + 1).padStart(2, "0")} at 19:00 UTC.`, link: `https://github.com/example/cofer/releases/tag/update-${String(n).padStart(2, "0")}` }, id);
  await bot.inboxTick();
}

describe("posts only what the release system reports", () => {
  test("nothing is posted for an update without a notice, even when its hour has passed", async () => {
    const { bot, t, clock, dir } = setup();
    await armed(bot, dir);
    t.sent.length = 0;
    clock.now = T0 + 3 * H;
    await bot.tick();
    expect(t.sent.filter((x) => x.m !== "send" || !x.text!.includes("LAUNCH")).filter((x) => x.m !== "pin" && x.m !== "edit")).toEqual([]);
    expect(bot.st.u).toEqual({});
  });

  test("armed: SCHEDULE ARMED and the schedule, and the board knows the launch time", async () => {
    const { bot, t, dir } = setup();
    await armed(bot, dir);
    expect(texts(t.sent)[0]).toStartWith("🟢 <b>SCHEDULE ARMED</b>");
    expect(texts(t.sent)[1]).toStartWith("<b>Day 1 · from Mon 30 Nov</b>");
    expect(bot.st.armedAt).toBe(LAUNCH);
  });

  test("update released: the full set in order in the staff group, then the status line", async () => {
    const { bot, t, dir, book } = setup();
    await armed(bot, dir);
    t.sent.length = 0;
    await releaseIt(bot, dir, 1);
    expect(t.sent.map((x) => [x.m, x.file ?? x.text!.split("\n")[0]])).toEqual([
      ["send", headingText(1)],
      ["photo", "update-01-square.png"],
      ["doc", "cofer-update-01-square.zip"],
      ["photo", "update-01-wide.png"],
      ["doc", "cofer-update-01-wide.zip"],
      ["send", "✅ <b>SHIPPED AND RELEASED · Update 01 · release update-01</b>"],
    ]);
    expect(t.sent.every((x) => x.chat === CHAT)).toBe(true);
    expect(t.sent[1]!.text).toBe(tgCopy(book, book.byN.get(1)!));
    expect(t.sent[2]!.text).toBe("Update 01 · square poster, full quality (1080x1080 PNG)");
    expect(t.sent[3]!.text).toBe(xCopy(book.byN.get(1)!));
    expect(t.sent[4]!.text).toBe("Update 01 · wide poster, full quality (1200x675 PNG)");
    expect(bot.st.u[1]!.state).toBe("released");
  });

  test("each zip holds only its poster, byte for byte", async () => {
    const { bot, dir } = setup();
    await armed(bot, dir);
    await releaseIt(bot, dir, 1);
    for (const shape of ["square", "wide"]) {
      const zip = new Uint8Array(fs.readFileSync(path.join(dir, "zips", `cofer-update-01-${shape}.zip`)));
      const posterBytes = new Uint8Array(fs.readFileSync(path.join(dir, "posters", shape, `update-01-${shape}.png`)));
      const name = `cofer-update-01-${shape}.png`;
      const at = 30 + name.length;
      expect(Buffer.from(zip.slice(30, at)).toString()).toBe(name);
      expect(Buffer.from(zip.slice(at, at + posterBytes.length)).equals(Buffer.from(posterBytes))).toBe(true);
      expect(zip.length).toBe(30 + name.length + posterBytes.length + 46 + name.length + 22); // one file, nothing else
    }
  });

  test("the same notice delivered twice posts once; a second notice for an update already out posts nothing", async () => {
    const { bot, t, dir } = setup();
    await armed(bot, dir);
    await releaseIt(bot, dir, 1, "rel-01");
    const n = t.sent.length;
    await releaseIt(bot, dir, 1, "rel-01");
    await releaseIt(bot, dir, 1, "rel-01-again");
    expect(t.sent.length).toBe(n);
    expect(fs.readdirSync(inboxDir(dir))).toEqual([]);
  });

  test("a crash part way through the set: after the restart the rest goes once each, in order", async () => {
    const { bot, t, dir, make, clock } = setup();
    await armed(bot, dir);
    t.sent.length = 0;
    t.s.fail.add("wide.png");
    await releaseIt(bot, dir, 1);
    expect(t.sent.map((x) => x.file ?? "text")).toEqual(["text", "update-01-square.png", "cofer-update-01-square.zip"]);
    t.s.fail.clear();
    const again = make(); // a restart
    await again.inboxTick(); // too soon: retries after 2 minutes
    expect(t.sent).toHaveLength(3);
    clock.now += RETRY_MS;
    await again.inboxTick();
    expect(t.sent.slice(3).map((x) => x.file ?? x.text!.split("\n")[0])).toEqual(["update-01-wide.png", "cofer-update-01-wide.zip", "✅ <b>SHIPPED AND RELEASED · Update 01 · release update-01</b>"]);
  });

  test("a fresh start after a release posts nothing again", async () => {
    const { bot, t, dir, make, clock } = setup();
    await bot.boardTick(true);
    await armed(bot, dir);
    await releaseIt(bot, dir, 1);
    t.sent.length = 0;
    const again = make();
    clock.now += 10 * MIN;
    await again.tick();
    expect(t.sent.filter((x) => x.m !== "edit" && x.m !== "pin")).toEqual([]);
  });

  test("cut off right after the heading: after the restart the heading is not sent again; the rest follows once", async () => {
    const { bot, t, dir, make, clock } = setup();
    await armed(bot, dir);
    t.sent.length = 0;
    t.s.fail.add("square.png");
    await releaseIt(bot, dir, 1);
    expect(texts(t.sent).map((x) => x.split("\n")[0])).toEqual([headingText(1)]);
    t.s.fail.clear();
    const again = make();
    clock.now += RETRY_MS;
    await again.inboxTick();
    expect(t.sent.slice(1).map((x) => x.file ?? x.text!.split("\n")[0])).toEqual(["update-01-square.png", "cofer-update-01-square.zip", "update-01-wide.png", "cofer-update-01-wide.zip", "✅ <b>SHIPPED AND RELEASED · Update 01 · release update-01</b>"]);
  });

  test("notices are handled in order: one that fails holds back the ones after it", async () => {
    const { bot, t, dir, clock } = setup();
    await armed(bot, dir);
    t.sent.length = 0;
    t.s.fail.add("sendMessage");
    notice(dir, { type: "held", n: 1, what: "The tests failed.", next: "x" });
    notice(dir, { type: "paused", reason: "check" });
    await bot.inboxTick();
    t.s.fail.clear();
    clock.now += RETRY_MS;
    await bot.inboxTick();
    expect(texts(t.sent).map((x) => x.split("\n")[0])).toEqual(["🟡 <b>HELD · Update 01 · release update-01</b>", "⏸ <b>PAUSED · updates</b>"]);
  });

  test("held, delayed and rolled back: the status line only; delayed then released: the full set and ✅", async () => {
    const { bot, t, dir } = setup();
    await armed(bot, dir);
    t.sent.length = 0;
    notice(dir, { type: "held", n: 2, what: "The tests failed while building Update 02.", next: "Fix it, then on the server: cofer-release release 2. Update 03 stays on time." });
    notice(dir, { type: "rolled_back", n: 3, what: "The mainnet live check failed; rolled back.", next: "Fix it." });
    notice(dir, { type: "delayed", n: 4, what: "Live and its checks pass; the GitHub release failed (502); retrying every 2 minutes.", next: "SHIPPED AND RELEASED follows when it goes through." });
    await bot.inboxTick();
    expect(t.sent.map((x) => x.text!.split("\n")[0])).toEqual([
      "🟡 <b>HELD · Update 02 · release update-02</b>",
      "🔴 <b>ROLLED BACK · Update 03 · release update-03</b>",
      "🟡 <b>RELEASE DELAYED · Update 04 · release update-04</b>",
    ]);
    expect(bot.held().map((u) => u.n)).toEqual([2, 3]);
    t.sent.length = 0;
    await releaseIt(bot, dir, 4);
    expect(t.sent.map((x) => x.m)).toEqual(["send", "photo", "doc", "photo", "doc", "send"]);
    expect(t.sent.at(-1)!.text).toStartWith("✅ <b>SHIPPED AND RELEASED · Update 04");
  });

  test("the last update: ALL LIVE, once", async () => {
    const { bot, t, dir } = setup({ count: 2 });
    await armed(bot, dir);
    await releaseIt(bot, dir, 1);
    await releaseIt(bot, dir, 2);
    await releaseIt(bot, dir, 2);
    expect(texts(t.sent).filter((x) => x.startsWith("🏁 <b>ALL 2 UPDATES ARE LIVE</b>"))).toHaveLength(1);
  });

  test("paused, resumed, disarmed and preflight are posted as reported", async () => {
    const { bot, t, dir } = setup();
    notice(dir, { type: "paused", reason: "planned check" });
    notice(dir, { type: "resumed", overdue: 2 });
    notice(dir, { type: "preflight", bad: [[3, ["The wide poster is missing."]]], total: 4 });
    notice(dir, { type: "disarmed" });
    await bot.inboxTick();
    expect(texts(t.sent).map((x) => x.split("\n")[0])).toEqual(["⏸ <b>PAUSED · updates</b>", "▶️ <b>RESUMED · updates</b>", "🟡 <b>PREFLIGHT · 3 of 4 ready</b>", "⏸ <b>SCHEDULE CANCELLED · launch</b>"]);
    expect(texts(t.sent)[1]).toContain("2 overdue updates go out first, 2 minutes apart");
  });

  test("a file that is not a notice is removed and posts nothing", async () => {
    const { bot, t, dir } = setup();
    fs.mkdirSync(inboxDir(dir), { recursive: true });
    fs.writeFileSync(path.join(inboxDir(dir), "x.json"), "{broken");
    fs.writeFileSync(path.join(inboxDir(dir), "y.json"), JSON.stringify({ id: "y", kind: "notice", type: "released", n: 1 })); // no what/next
    fs.writeFileSync(path.join(inboxDir(dir), "z.json"), JSON.stringify({ id: "z", cmd: "pause" })); // an old server command
    await bot.inboxTick();
    expect(t.sent).toEqual([]);
    expect(fs.readdirSync(inboxDir(dir))).toEqual([]);
  });

  test("test N: the full set and status line to Alert Test only, marked TEST, and nothing remembered", async () => {
    const { bot, t, dir } = setup();
    notice(dir, { type: "test", n: 2, what: "A test.", next: "Nothing." });
    await bot.inboxTick();
    expect(t.sent).toHaveLength(6);
    expect(t.sent.every((x) => x.chat === ALERT)).toBe(true);
    expect(t.sent.every((x) => x.text!.startsWith(`<b>${TEST_LABEL}</b>`) || x.text!.startsWith(TEST_LABEL))).toBe(true);
    expect(bot.st.u).toEqual({});
  });

  test("a dry run marks every staff post and every emergency differently, so Alert Test can tell them apart", async () => {
    const labels = { staff: "🧪 DRY RUN · STAFF POST (would go to the staff group)", alarm: "🧪 DRY RUN · EMERGENCY" };
    const { bot, t, dir } = setup({ labels });
    await armed(bot, dir);
    await releaseIt(bot, dir, 1);
    notice(dir, { type: "alarm", alarm: { name: "release-tests-failed", what: "w", who: "x", n: 2 } });
    await bot.inboxTick();
    const staff = t.sent.filter((x) => x.chat === CHAT);
    expect(staff.every((x) => x.text!.includes(labels.staff))).toBe(true);
    const alarm = t.sent.filter((x) => x.chat === ALERT);
    expect(alarm).toHaveLength(1);
    expect(alarm[0]!.text).toStartWith(`<b>${labels.alarm}</b>\n🔴 <b>ALERT · release-tests-failed</b>`);
  });
});

describe("the launch announcement", () => {
  test("at the launch minute: the launch poster with the write-up, once; text if the poster is missing", async () => {
    const { bot, t, dir } = setup();
    fs.mkdirSync(path.join(dir, "kit"), { recursive: true });
    fs.writeFileSync(path.join(dir, "kit", "launch-announcement-square.png"), "png");
    await armed(bot, dir);
    t.sent.length = 0;
    notice(dir, { type: "launch" });
    notice(dir, { type: "launch" });
    await bot.inboxTick();
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatchObject({ m: "photo", file: "launch-announcement-square.png", html: true, chat: CHAT });
    expect(t.sent[0]!.text).toStartWith("🟢 <b>COFER IS LIVE</b>");
    const b = setup();
    await armed(b.bot, b.dir);
    b.t.sent.length = 0;
    notice(b.dir, { type: "launch" });
    await b.bot.inboxTick();
    expect(b.t.sent[0]).toMatchObject({ m: "send" });
  });
});

describe("release emergencies in Alert Test", () => {
  let uid = 9000;
  const ackMsg = (o: { chat?: number; text?: string; replyTo?: number } = {}): TgUpdate => ({
    update_id: uid++,
    message: { message_id: uid, chat: { id: o.chat ?? ALERT }, from: { is_bot: false }, text: o.text ?? "/ack", ...(o.replyTo ? { reply_to_message: { message_id: o.replyTo, chat: { id: ALERT } } } : {}) },
  });
  const open = (dir: string, name = "release-tests-failed", n = 7) =>
    notice(dir, { type: "alarm", alarm: { name, what: `The tests failed while building Update ${String(n).padStart(2, "0")}.`, who: `Dev fixes it, then on the server: cofer-release release ${n}.`, n, postAt: LAUNCH } });

  test("sent at once, repeated every 2 minutes; /ack pauses it 15 minutes; then repeats; one cleared message", async () => {
    const { bot, t, dir, clock } = setup();
    await bot.setup();
    open(dir);
    await bot.inboxTick();
    const first = t.sent.filter((x) => x.chat === ALERT);
    expect(first).toHaveLength(1);
    expect(first[0]!.text).toStartWith("🔴 <b>ALERT · release-tests-failed</b>");
    expect(first[0]!.text).not.toContain("Still open");
    clock.now += ALARM_REPEAT_MS - 1;
    await bot.alarmTick();
    expect(t.sent.filter((x) => x.chat === ALERT)).toHaveLength(1);
    clock.now += 1;
    await bot.alarmTick();
    expect(t.sent.filter((x) => x.chat === ALERT).at(-1)!.text).toContain("Still open after 2m.");
    await bot.handle(ackMsg({ replyTo: first[0]!.id }));
    expect(texts(t.sent).at(-1)).toBe("Paused for 15 minutes: release-tests-failed. It repeats every 2 minutes after that if it is still open.");
    const n = t.sent.length;
    clock.now += ACK_PAUSE_MS - 1;
    await bot.alarmTick();
    expect(t.sent.length).toBe(n);
    clock.now += 1;
    await bot.alarmTick();
    expect(t.sent.at(-1)!.text).toContain("Still open after 17m.");
    notice(dir, { type: "cleared", name: "release-tests-failed", reason: "Update 07 is ready for its posting time" });
    await bot.inboxTick();
    expect(t.sent.at(-1)!.text).toBe("🟢 <b>CLEARED · release-tests-failed</b> (Update 07 is ready for its posting time)");
    clock.now += 10 * MIN;
    await bot.alarmTick();
    notice(dir, { type: "cleared", name: "release-tests-failed", reason: "again" });
    await bot.inboxTick();
    expect(t.sent.at(-1)!.text).toStartWith("🟢"); // nothing more after the one cleared message
    expect(t.sent.filter((x) => x.text!.startsWith("🟢"))).toHaveLength(1);
    expect(t.sent.filter((x) => x.chat === CHAT)).toEqual([]); // the staff group never sees an emergency
  });

  test("/ack by name, /ack alone with one open, and the answers when it is unclear", async () => {
    const { bot, t, dir } = setup();
    await bot.setup();
    await bot.handle(ackMsg());
    expect(texts(t.sent).at(-1)).toBe("Nothing is open.");
    open(dir, "release-tests-failed");
    open(dir, "release-push-failed");
    await bot.inboxTick();
    await bot.handle(ackMsg({ text: "/ack" }));
    expect(texts(t.sent).at(-1)).toBe("Which one? Send /ack and its name (open: release-tests-failed, release-push-failed).");
    await bot.handle(ackMsg({ text: "/ack@cofer_alerts_bot release-push-failed" }));
    expect(texts(t.sent).at(-1)).toStartWith("Paused for 15 minutes: release-push-failed.");
    expect(bot.st.alarms["release-push-failed"]!.ackUntil).toBeGreaterThan(0);
    expect(bot.st.alarms["release-tests-failed"]!.ackUntil).toBe(0);
  });

  test("/ack anywhere but Alert Test does nothing", async () => {
    const { bot, t, dir } = setup();
    await bot.setup();
    open(dir);
    await bot.inboxTick();
    const n = t.sent.length;
    await bot.handle(ackMsg({ chat: CHAT }));
    await bot.handle(ackMsg({ chat: 555 }));
    expect(t.sent.length).toBe(n);
  });

  test("the release system's heartbeat: missing while armed is an emergency; back again, one cleared", async () => {
    const beat = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rel-beat-")), "heartbeat");
    const { bot, t, dir, clock } = setup({ releaseHeartbeat: beat });
    await bot.watchRelease(); // not armed: nothing
    expect(t.sent.filter((x) => x.chat === ALERT)).toEqual([]);
    await armed(bot, dir);
    await bot.watchRelease();
    expect(t.sent.filter((x) => x.chat === ALERT).at(-1)!.text).toStartWith("🔴 <b>ALERT · release-system-stopped</b>");
    fs.writeFileSync(beat, "x");
    const now = new Date(clock.now);
    fs.utimesSync(beat, now, now);
    await bot.watchRelease();
    expect(t.sent.at(-1)!.text).toBe("🟢 <b>CLEARED · release-system-stopped</b> (it is running again)");
  });

  test("the team bot writes its own heartbeat every tick", async () => {
    const { bot, dir, clock } = setup();
    await bot.tick();
    expect(Math.abs(fs.statSync(heartbeatPath(dir)).mtimeMs - clock.now)).toBeLessThan(1000);
  });
});

describe("the board poster and Shipped today", () => {
  const boardPoster = (dir: string, live: number) => {
    fs.mkdirSync(path.join(dir, "posters", "board"), { recursive: true });
    fs.writeFileSync(path.join(dir, "posters", "board", `board-${String(live).padStart(2, "0")}.png`), "png");
  };

  test("30 minutes after a release: the drawn board poster with the board as its caption, once", async () => {
    const { bot, t, dir, clock } = setup();
    boardPoster(dir, 1);
    await armed(bot, dir);
    clock.now = T0;
    await releaseIt(bot, dir, 1);
    t.sent.length = 0;
    clock.now += BOARD_POSTER_AFTER_MS - 1;
    await bot.boardPosterTick();
    expect(t.sent).toEqual([]);
    clock.now += 1;
    await bot.boardPosterTick();
    await bot.boardPosterTick();
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatchObject({ m: "photo", file: "board-01.png", html: true, chat: CHAT });
    expect(t.sent[0]!.text).toStartWith("<b>COFER LAUNCH</b>");
  });

  test("two releases close together: only the latest board poster; with a held update the board goes as text", async () => {
    const { bot, t, dir, clock } = setup();
    boardPoster(dir, 1);
    boardPoster(dir, 2);
    await armed(bot, dir);
    clock.now = T0;
    await releaseIt(bot, dir, 1);
    clock.now += 10 * MIN;
    notice(dir, { type: "held", n: 2, what: "The tests failed.", next: "x" });
    await releaseIt(bot, dir, 3);
    t.sent.length = 0;
    clock.now += BOARD_POSTER_AFTER_MS;
    await bot.boardPosterTick();
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.m).toBe("send");
    expect(t.sent[0]!.text).toStartWith("<b>COFER LAUNCH</b>");
  });

  test("Shipped today at 23:55 UTC, once, only on a day with releases", async () => {
    const { bot, t, dir, clock } = setup();
    clock.now = Date.parse("2026-11-29T23:56:00Z");
    await bot.summaryTick();
    expect(t.sent).toEqual([]); // no releases that day
    await armed(bot, dir);
    clock.now = T0;
    await releaseIt(bot, dir, 1);
    t.sent.length = 0;
    clock.now = Date.parse("2026-11-30T23:54:59Z");
    await bot.summaryTick();
    expect(t.sent).toEqual([]);
    clock.now = Date.parse("2026-11-30T23:55:00Z");
    await bot.summaryTick();
    await bot.summaryTick();
    expect(texts(t.sent)).toHaveLength(1);
    expect(texts(t.sent)[0]).toStartWith("<b>Shipped today · 2026-11-30 (UTC)</b>\n23:55 UTC · 02:55 Moscow · 6:55 PM New York\n\n1 update released:\n• Update 01 · Sample title 1");
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
    expect(texts(t.sent)[0]).toStartWith("<b>COFER LAUNCH</b>");
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
    void clock;
    await bot.handle(msg("/poster 2"));
    await bot.handle(msg("/poster"));
    await bot.handle(msg("/schedule"));
    expect(texts(t.sent)).toEqual(["Update 02 is not live yet. Its posters are shared here at its hour.", "Send it with a number, like /poster 14.", "The launch time is not set yet."]);
    await armed(bot, dir);
    await releaseIt(bot, dir, 1);
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

describe("replies to the bot's own messages", () => {
  let uid = 5000;
  const BOT = { is_bot: true, username: "cofer_alerts_bot" };
  /** A person (or a bot) replying in a chat to a message with this text or caption. */
  const replyTo = (to: { text?: string; caption?: string; from?: { is_bot?: boolean; username?: string }; id?: number }, o: { chat?: number; bot?: boolean; text?: string } = {}): TgUpdate => ({
    update_id: uid++,
    message: {
      message_id: uid,
      chat: { id: o.chat ?? CHAT },
      from: { is_bot: !!o.bot },
      text: o.text ?? "what is this?",
      reply_to_message: { message_id: to.id ?? uid + 100000, chat: { id: o.chat ?? CHAT }, from: to.from ?? BOT, text: to.text, caption: to.caption },
    },
  });
  const ready = async (o: Parameters<typeof setup>[0] = {}) => {
    const s = setup(o);
    await s.bot.setup();
    return s;
  };

  test("whatever message of ours is replied to, the answer is the same one line", async () => {
    const { bot, t, book, dir } = await ready();
    await armed(bot, dir);
    await releaseIt(bot, dir, 1);
    t.sent.length = 0;
    const u1 = book.byN.get(1)!;
    const ours = [
      { text: plainText(headingText(1)) },
      { caption: tgCopy(book, u1) },
      { caption: xCopy(u1) },
      { text: "🟡 ALERT · feed-stale:TSLA\n\nWhat happened: The TSLA price is 3 hours old.\nWho acts: Dev checks." },
      { text: "🟢 CLEARED · relayer-low (topped up)" },
      { text: "[cofer alert] indexer-lag" },
      { text: "COFER LAUNCH\nLive 1 / 3" },
      {},
    ];
    for (const to of ours) await bot.handle(replyTo(to));
    expect(texts(t.sent)).toEqual(ours.map(() => REPLY_ONLY));
    expect(t.sent.every((x) => x.chat === CHAT)).toBe(true);
    expect(REPLY_ONLY).toBe("I answer commands only: /status, /next, /schedule, /poster N, /changelog, /roadmap, /contracts, /socials, /videos, /health, /help.");
  });

  test("ignored: replies from bots, other chats, replies to people or other bots, plain messages in a topic", async () => {
    const { bot, t } = await ready();
    await bot.handle(replyTo({ text: "COFER LAUNCH" }, { bot: true }));
    await bot.handle(replyTo({ text: "COFER LAUNCH" }, { chat: 555 }));
    await bot.handle(replyTo({ text: "lunch?", from: { is_bot: false, username: "someone" } }));
    await bot.handle(replyTo({ text: "COFER LAUNCH", from: { is_bot: true, username: "other_bot" } }));
    const inTopic = replyTo({ text: "Topic made by the bot", id: 77 });
    inTopic.message!.is_topic_message = true;
    inTopic.message!.message_thread_id = 77;
    await bot.handle(inTopic);
    expect(t.sent).toEqual([]);
  });

  test("a command sent as a reply is answered as the command, not as a reply", async () => {
    const { bot, t } = await ready();
    await bot.handle(replyTo({ text: "COFER LAUNCH" }, { text: "/next" }));
    expect(texts(t.sent)).toEqual(["The launch time is not set yet."]);
  });

  test("the same message is answered at most once in 30 seconds, whoever replies", async () => {
    const { bot, t, clock } = await ready();
    const board = { text: "COFER LAUNCH", id: 42 };
    await bot.handle(replyTo(board));
    await bot.handle(replyTo(board, { text: "and now?" }));
    clock.now += SAME_REPLY_MS - 1;
    await bot.handle(replyTo(board));
    expect(t.sent).toHaveLength(1);
    await bot.handle(replyTo({ text: "COFER LAUNCH", id: 43 })); // another message: answered
    expect(t.sent).toHaveLength(2);
    clock.now += 1;
    await bot.handle(replyTo(board));
    expect(t.sent).toHaveLength(3);
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
  test("documents (the zips) are uploaded with their caption", async () => {
    const dir = dataDir(1);
    const s = fakeFetch(() => tgOk({ message_id: 11, date: 0, chat: { id: CHAT, type: "supergroup" } }));
    expect(await telegramClient(TOKEN, { fetch: s.f }).document(CHAT, path.join(dir, "posters", "square", "update-01-square.png"), "cap")).toBe(11);
    expect(s.calls[0]!.url).toEndWith("/sendDocument");
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
      expect(maybeStartTeambot(parseEnv({ ...base, CHAIN_ID: "46630", TEAMBOT_ENABLED: "1", TEAMBOT_DATA_DIR: dataDir(1), TEAMBOT_TEST_CHAT_ID: "-1009999" }))).toBeNull();
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
      expect(maybeStartTeambot(parseEnv({ ...base, TEAMBOT_ENABLED: "1", TEAMBOT_DATA_DIR: dataDir(1), TEAMBOT_TEST_CHAT_ID: "-1009999" }))).toBeNull();
      expect(err.mock.calls.map((c) => c.join(" ")).join("\n")).toContain("not started: updates.json could not be read from the data folder");
    } finally {
      err.mockRestore();
    }
  });
});
