/**
 * The team bot at work, on the existing alert bot. It is the only poster of the launch, and it posts
 * only what the release system tells it (notices in TEAMBOT_DATA_DIR/inbox, see notices.ts); it has
 * no clock of its own for updates.
 *   - "update NN released" (sent at its posting minute, once it is live on testnet and mainnet and
 *     published): the full set in the staff group: the heading, the square poster with the Telegram
 *     text, a zip with only that poster, the wide poster with the X text, a zip with only that poster,
 *     then the status line; LAUNCHED before update 1 and ALL LIVE after the last
 *   - held, delayed and rolled back: that status line only
 *   - armed, disarmed, paused, resumed, preflight: the matching staff-group message
 *   - release emergencies: in Alert Test (TEAMBOT_TEST_CHAT_ID), at once, then every 2 minutes until
 *     cleared; /ack in Alert Test pauses one for 15 minutes; one cleared message at the end
 *   - one pinned launch board, edited in place; a board poster 30 minutes after each release (the
 *     board as text whenever an update is held); "Shipped today" at 23:55 UTC
 *   - staff-group commands (/status /next /schedule /poster /changelog /roadmap /contracts /socials
 *     /videos /video /health /help), only in the staff group, ignoring other bots
 *   - its own heartbeat file every tick, and an alarm when the release system's heartbeat stops
 * Everything that has gone out is saved in state.json before and after each post, so a restart
 * neither repeats nor skips one.
 */
import fs from "node:fs";
import path from "node:path";
import { redact } from "../core/errors";
import { pad, posterPath, relUrl, roadmapPath, type Book, type Shape, type Update } from "./data";
import {
  ACK_NONE,
  ackText,
  ackWhich,
  alarmText,
  allLiveText,
  armedText,
  boardKey,
  boardText,
  changelogReply,
  clearedText,
  contractsText,
  currentDay,
  days,
  disarmedText,
  healthText,
  HELP,
  launchedText,
  MENU,
  nextText,
  noDayText,
  NOT_SET,
  pausedText,
  posterCaption,
  posterNotLive,
  posterUsage,
  preflightText,
  resumedText,
  roadmapCaption,
  scheduleDay,
  shippedTodayText,
  socialsText,
  statusLineText,
  tgCopy,
  videosText,
  videoUsage,
  xCopy,
  headingText,
  REPLY_ONLY,
  zipCaption,
  type HealthRow,
} from "./messages";
import { asNotice, HEARTBEAT_STALE_MS, type AlarmNotice, type Notice } from "./notices";
import { held, loadState, released, saveState, us, type Alarm, type State, type StatusKind } from "./state";
import type { Tg, TgMessage, TgUpdate } from "./telegram";
import { storedZip } from "./zip";

export const TICK_MS = 10_000;
const BOARD_REFRESH_MS = 5 * 60_000;
const SAME_COMMAND_MS = 5_000;
/** A reply to the same message of ours is answered at most once in this time. */
export const SAME_REPLY_MS = 30_000;
/** A release emergency repeats this often until it clears. */
export const ALARM_REPEAT_MS = 2 * 60_000;
/** /ack pauses one alarm this long. */
export const ACK_PAUSE_MS = 15 * 60_000;
/** The board poster goes out this long after a release. */
export const BOARD_POSTER_AFTER_MS = 30 * 60_000;
/** A notice that could not be posted is tried again after this. */
export const RETRY_MS = 2 * 60_000;
/** "Shipped today" goes out at this UTC time, for that UTC day. */
export const SUMMARY_AT = "23:55";
const SEEN_KEEP = 2000;
export const KNOWN = new Set(["help", "start", "status", "next", "schedule", "poster", "changelog", "roadmap", "contracts", "socials", "videos", "video", "health"]);

/** Dry runs and test posts carry a first line, so they can never be taken for the real thing in Alert Test. */
export interface Labels {
  staff?: string; // e.g. "🧪 DRY RUN · STAFF POST (would go to the staff group)"
  alarm?: string; // e.g. "🧪 DRY RUN · EMERGENCY"
}
export const TEST_LABEL = "🧪 TEST · STAFF POST (sent to Alert Test only)";

export interface TeambotDeps {
  book: Book;
  tg: Tg;
  chat: number; // the staff group (in a dry run: the test group)
  alertChat?: number; // Alert Test: release emergencies, /ack and test posts
  releaseHeartbeat?: string; // the release system's heartbeat file
  labels?: Labels;
  now?: () => number;
  log?: (...a: unknown[]) => void;
  posterExists?: (p: string) => boolean;
  fetch?: typeof fetch; // for /health
  sleep?: (ms: number) => Promise<void>;
}

export const inboxDir = (dataDir: string) => path.join(dataDir, "inbox");
export const heartbeatPath = (dataDir: string) => path.join(dataDir, "heartbeat");
export const boardPosterPath = (book: Book, live: number) => path.join(book.dataDir, "posters", "board", `board-${pad(live)}.png`);
const sentence = (e: unknown) => {
  const m = redact(e instanceof Error ? e.message : String(e));
  return m.endsWith(".") ? m : `${m}.`;
};

/** The width and height in a PNG's header, or null. */
export function pngSize(b: Uint8Array): { w: number; h: number } | null {
  if (b.length < 24 || b[0] !== 0x89 || b[1] !== 0x50 || b[12] !== 0x49 || b[13] !== 0x48) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { w: v.getUint32(16), h: v.getUint32(20) };
}

export function createTeambot(d: TeambotDeps) {
  const { book, tg, chat } = d;
  const now = d.now ?? Date.now;
  const log = d.log ?? ((...a: unknown[]) => console.log("[teambot]", ...a.map((x) => redact(String(x)))));
  const sleep = d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const exists = d.posterExists ?? fs.existsSync;
  const dataDir = book.dataDir;
  const st: State = loadState(dataDir);
  const save = () => saveState(dataDir, st);

  // ---------------- sending, with the dry-run / test label ----------------
  const htmlLabel = (l?: string) => (l ? `<b>${l}</b>\n` : "");
  const plainLabel = (l?: string) => (l ? `${l}\n\n` : "");
  const say = (html: string, label = d.labels?.staff, to = chat) => tg.send(to, htmlLabel(label) + html);
  const photo = (file: string, caption: string, isHtml = false, label = d.labels?.staff, to = chat) =>
    tg.photo(to, file, (isHtml ? htmlLabel(label) : plainLabel(label)) + caption, isHtml);
  const doc = (file: string, caption: string, label = d.labels?.staff, to = chat) => tg.document(to, file, plainLabel(label) + caption);

  function zipFile(n: number, shape: Shape): { file: string; caption: string } {
    const src = posterPath(book, n, shape);
    const bytes = new Uint8Array(fs.readFileSync(src));
    const dir = path.join(dataDir, "zips");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const name = `cofer-update-${pad(n)}-${shape}`;
    const out = path.join(dir, `${name}.zip`);
    if (!fs.existsSync(out)) {
      fs.writeFileSync(`${out}.tmp`, storedZip(`${name}.png`, bytes, new Date(now())), { mode: 0o600 });
      fs.renameSync(`${out}.tmp`, out);
    }
    return { file: out, caption: zipCaption(n, shape, pngSize(bytes)) };
  }

  // ---------------- the full set, in order, each part saved as it goes ----------------
  async function fullSet(u: Update, n: { what: string; next: string; link?: string }, test: boolean): Promise<void> {
    if (test) {
      const to = d.alertChat ?? chat;
      await say(headingText(u.n), TEST_LABEL, to);
      await photo(posterPath(book, u.n, "square"), tgCopy(book, u), false, TEST_LABEL, to);
      const zs = zipFile(u.n, "square");
      await doc(zs.file, zs.caption, TEST_LABEL, to);
      await photo(posterPath(book, u.n, "wide"), xCopy(u), false, TEST_LABEL, to);
      const zw = zipFile(u.n, "wide");
      await doc(zw.file, zw.caption, TEST_LABEL, to);
      await say(statusLineText("released", u.n, u.title, n.what, n.next, n.link ?? relUrl(book, u.n)), TEST_LABEL, to);
      return;
    }
    const s = us(st, u.n);
    if (s.state !== "released") {
      s.state = "posting";
      save();
    }
    if (u.n === 1 && !st.launchedPosted) {
      await say(launchedText(st, book));
      st.launchedPosted = true;
      save();
    }
    if (!s.head) {
      s.head = await say(headingText(u.n));
      save();
    }
    if (!s.tg) {
      s.tg = await photo(posterPath(book, u.n, "square"), tgCopy(book, u));
      save();
    }
    if (!s.zipSq) {
      const z = zipFile(u.n, "square");
      s.zipSq = await doc(z.file, z.caption);
      save();
    }
    if (!s.x) {
      s.x = await photo(posterPath(book, u.n, "wide"), xCopy(u));
      save();
    }
    if (!s.zipX) {
      const z = zipFile(u.n, "wide");
      s.zipX = await doc(z.file, z.caption);
      save();
    }
    if (!s.lines?.released) {
      (s.lines ||= {}).released = await say(statusLineText("released", u.n, u.title, n.what, n.next, n.link ?? relUrl(book, u.n)));
      Object.assign(s, { state: "released", reason: null, at: new Date(now()).toISOString() });
      st.lastReleaseAt = now();
      st.boardPoster = { dueAt: now() + BOARD_POSTER_AFTER_MS, live: released(st, book).length }; // a later release replaces it: only the latest goes
      save();
      log("released", u.n);
    }
    if (released(st, book).length === book.total && !st.finishedPosted) {
      st.finishedPosted = true;
      save();
      await say(allLiveText(book, now()));
    }
  }

  /** Held, delayed or rolled back: its status line only, once per outcome. */
  async function outcome(kind: Exclude<StatusKind, "released">, u: Update, n: { id: string; what: string; next: string; link?: string }): Promise<void> {
    const s = us(st, u.n);
    if (s.state === "released") return; // already out: an older notice
    if (s.lastNotice === n.id) return; // posted just before a restart
    (s.lines ||= {})[kind] = await say(statusLineText(kind, u.n, u.title, n.what, n.next, n.link));
    Object.assign(s, { state: kind, reason: n.what, at: new Date(now()).toISOString(), lastNotice: n.id });
    save();
  }

  // ---------------- release emergencies ----------------
  const alertTo = () => d.alertChat;
  async function sendAlarm(a: Alarm): Promise<void> {
    const to = alertTo();
    if (to === undefined) {
      log("no Alert Test group set: alarm not sent", a.name);
      return;
    }
    const mins = a.lastSentAt ? Math.floor((now() - a.openedAt) / 60_000) : 0;
    const id = await say(alarmText(a, mins), d.labels?.alarm, to);
    a.lastSentAt = now();
    a.messages = [...a.messages, id].slice(-50);
    save();
  }

  async function openAlarm(n: AlarmNotice, own = false): Promise<void> {
    const had = st.alarms[n.name];
    if (had) {
      Object.assign(had, { what: n.what, who: n.who, n: n.n, postAt: n.postAt }); // the same problem, newer words
      save();
      return;
    }
    const a: Alarm = { ...n, openedAt: now(), lastSentAt: 0, ackUntil: 0, messages: [], own };
    st.alarms[n.name] = a;
    save();
    await sendAlarm(a);
  }

  async function clearAlarm(name: string, reason: string): Promise<void> {
    if (!st.alarms[name]) return; // never open here: nothing to clear
    const to = alertTo();
    if (to !== undefined) await say(clearedText(name, reason), d.labels?.alarm, to);
    delete st.alarms[name];
    save();
  }

  async function alarmTick(): Promise<void> {
    for (const a of Object.values(st.alarms)) {
      if (now() < a.ackUntil) continue;
      if (a.lastSentAt && now() - a.lastSentAt < ALARM_REPEAT_MS) continue;
      try {
        await sendAlarm(a);
      } catch (e) {
        log("alarm not sent", a.name, sentence(e));
      }
    }
  }

  /** Watches the release system's heartbeat while the launch is armed. */
  async function watchRelease(): Promise<void> {
    if (!d.releaseHeartbeat || !st.armedAt || st.finishedPosted) return;
    let age = Infinity;
    try {
      age = now() - fs.statSync(d.releaseHeartbeat).mtimeMs;
    } catch {
      /* missing */
    }
    const name = "release-system-stopped";
    if (age > HEARTBEAT_STALE_MS) {
      await openAlarm(
        {
          name,
          what: `The release system has stopped: its heartbeat is ${Number.isFinite(age) ? `${Math.floor(age / 60_000)} minutes old` : "missing"}. Nothing is built, deployed or released until it runs again.`,
          who: "Dev: on the server, check the release system (systemctl status cofer-ship and its log) and start it again.",
        },
        true,
      );
    } else if (st.alarms[name]?.own) await clearAlarm(name, "it is running again");
  }

  /** /ack in Alert Test: pause one alarm for 15 minutes. */
  async function ack(m: TgMessage, arg: string): Promise<void> {
    const to = alertTo()!;
    const open = Object.values(st.alarms);
    let a: Alarm | undefined;
    if (m.reply_to_message) a = open.find((x) => x.messages.includes(m.reply_to_message!.message_id));
    if (!a && arg) a = st.alarms[arg.trim()];
    if (!a && !arg && open.length === 1) a = open[0];
    if (!a) {
      await say(open.length ? ackWhich(open.map((x) => x.name)) : ACK_NONE, d.labels?.alarm, to);
      return;
    }
    a.ackUntil = now() + ACK_PAUSE_MS;
    save();
    await say(ackText(a.name), d.labels?.alarm, to);
  }

  // ---------------- notices from the release system ----------------
  async function applyNotice(n: Notice): Promise<void> {
    switch (n.type) {
      case "armed":
        st.armedAt = new Date(n.at).toISOString();
        save();
        await say(armedText(!!n.changed, new Date(n.at), book));
        for (let day = 1; day <= days(book); day++) await say(scheduleDay(st, book, day)!);
        return;
      case "disarmed":
        st.armedAt = null;
        save();
        await say(disarmedText());
        return;
      case "paused":
        st.paused = { reason: n.reason || "planned pause", at: new Date(now()).toISOString() };
        save();
        await say(pausedText(st.paused.reason));
        return;
      case "resumed":
        st.paused = null;
        save();
        await say(resumedText(st, book, n.overdue));
        return;
      case "preflight":
        await say(preflightText(n.bad, n.total));
        return;
      case "alarm":
        await openAlarm(n.alarm);
        return;
      case "cleared":
        await clearAlarm(n.name, n.reason);
        return;
    }
    const u = book.byN.get(n.n);
    if (!u) {
      log("notice for an unknown update", n.n);
      return;
    }
    if (n.type === "test") return fullSet(u, n, true);
    if (n.type === "released") return fullSet(u, n, false);
    return outcome(n.type, u, n);
  }

  async function inboxTick(): Promise<void> {
    const dir = inboxDir(dataDir);
    if (!fs.existsSync(dir) || now() < st.retryAt) return;
    for (const f of fs
      .readdirSync(dir)
      .filter((x) => x.endsWith(".json"))
      .sort()) {
      const p = path.join(dir, f);
      let n: Notice | null = null;
      try {
        n = asNotice(JSON.parse(fs.readFileSync(p, "utf8")));
      } catch {
        n = null;
      }
      if (!n) {
        log("removed a file that is not a notice:", f);
        fs.rmSync(p, { force: true });
        continue;
      }
      if (!st.seen.includes(n.id)) {
        try {
          await applyNotice(n);
        } catch (e) {
          st.retryAt = now() + RETRY_MS; // in order: nothing after it goes before it
          save();
          log("notice not posted yet, trying again in 2 minutes:", n.type, sentence(e));
          return;
        }
        st.seen = [...st.seen, n.id].slice(-SEEN_KEEP);
        save();
      }
      fs.rmSync(p, { force: true });
    }
  }

  // ---------------- the pinned board, its poster, Shipped today ----------------
  let lastBoard = { key: "", at: 0 };
  async function boardTick(force = false): Promise<void> {
    const text = boardText(st, book, now());
    const key = boardKey(text);
    if (!force && key === lastBoard.key && now() - lastBoard.at < BOARD_REFRESH_MS) return;
    try {
      if (st.board) {
        try {
          await tg.edit(chat, st.board, htmlLabel(d.labels?.staff) + text);
        } catch (e) {
          const m = e instanceof Error ? e.message : "";
          if (/not modified/i.test(m)) {
            /* same text */
          } else if (/not found|can't be edited|MESSAGE_ID_INVALID/i.test(m)) st.board = null;
          else throw e;
        }
      }
      if (!st.board) {
        st.board = await say(text);
        save();
        await tg.pin(chat, st.board).catch((e) => log('could not pin the board (make the bot an admin with "Pin messages"):', sentence(e)));
      }
      lastBoard = { key, at: now() };
    } catch (e) {
      log("board error", sentence(e));
    }
  }

  async function boardPosterTick(): Promise<void> {
    const bp = st.boardPoster;
    if (!bp || now() < bp.dueAt) return;
    const text = boardText(st, book, now());
    const img = boardPosterPath(book, bp.live);
    try {
      if (held(st, book).length || !exists(img)) await say(text);
      else await photo(img, text, true);
      st.boardPoster = null;
      save();
    } catch (e) {
      bp.dueAt = now() + RETRY_MS;
      save();
      log("board poster not sent, trying again in 2 minutes:", sentence(e));
    }
  }

  async function summaryTick(): Promise<void> {
    const t = new Date(now());
    const day = t.toISOString().slice(0, 10);
    if (t.toISOString().slice(11, 16) < SUMMARY_AT || st.summaryDays.includes(day)) return;
    const list = released(st, book)
      .filter((u) => (st.u[u.n]?.at ?? "").startsWith(day))
      .map((u) => ({ n: u.n, title: u.title, url: relUrl(book, u.n) }));
    if (!list.length) return; // only on days with releases
    try {
      await say(shippedTodayText(day, list, t));
      st.summaryDays = [...st.summaryDays, day].slice(-60);
      save();
    } catch (e) {
      log("Shipped today not sent:", sentence(e));
    }
  }

  // ---------------- staff-group commands ----------------
  async function health(): Promise<HealthRow[]> {
    const f = d.fetch ?? fetch;
    return Promise.all(
      book.cfg.health.map(async (h): Promise<HealthRow> => {
        const t0 = now();
        try {
          const r = await f(h.url, { signal: AbortSignal.timeout(8000) });
          return { name: h.name, status: r.status, ok: r.ok, ms: now() - t0 };
        } catch {
          return { name: h.name };
        }
      }),
    );
  }

  async function command(cmd: string, arg: string): Promise<unknown> {
    const n = parseInt(arg, 10);
    switch (cmd) {
      case "help":
      case "start":
        return say(HELP);
      case "status":
        return say(boardText(st, book, now()));
      case "next":
        return say(nextText(st, book, now()));
      case "schedule": {
        if (!st.armedAt) return say(NOT_SET);
        const day = n || currentDay(st, book, now());
        return say(scheduleDay(st, book, day) ?? noDayText(day));
      }
      case "poster": {
        if (!book.byN.has(n)) return say(posterUsage);
        if (st.u[n]?.state !== "released") return say(posterNotLive(n));
        for (const shape of ["square", "wide"] as const) {
          const p = posterPath(book, n, shape);
          if (exists(p)) await photo(p, posterCaption(n, shape === "wide"));
        }
        return;
      }
      case "changelog":
        return say(changelogReply(st, book));
      case "roadmap": {
        const cap = roadmapCaption(st, book);
        const img = roadmapPath(book);
        return img && exists(img) ? photo(img, cap, true) : say(cap);
      }
      case "contracts":
        return say(contractsText(book));
      case "socials":
        return say(socialsText(book));
      case "videos":
        return say(videosText(book));
      case "video": {
        const v = book.cfg.videos[n - 1];
        if (!v) return say(videoUsage(book));
        return tg.copy(chat, v.fromChat ?? chat, v.messageId);
      }
      case "health":
        return say(healthText(await health(), st, now()));
      default:
        return null; // not ours: stay quiet
    }
  }

  let me: string | null = null;
  const lastCmd = new Map<string, number>();
  const lastReply = new Map<number, number>();

  /** A person replied (not with a command) to a message this bot sent, in the staff group. */
  async function reply(m: TgMessage): Promise<void> {
    const to = m.reply_to_message!;
    if (!me || !to.from?.is_bot || to.from.username?.toLowerCase() !== me.toLowerCase()) return; // not one of ours
    if (m.is_topic_message && to.message_id === m.message_thread_id) return; // just a message in a topic, not a reply
    if (now() - (lastReply.get(to.message_id) ?? -Infinity) < SAME_REPLY_MS) return; // a busy thread: answer once
    lastReply.set(to.message_id, now());
    for (const [id, at] of lastReply) if (now() - at >= SAME_REPLY_MS) lastReply.delete(id);
    try {
      await say(REPLY_ONLY);
    } catch (e) {
      log("reply error", sentence(e));
    }
  }

  /** One update from Telegram: /ack in Alert Test; in the staff group our commands, and replies to our messages. */
  async function handle(up: TgUpdate): Promise<void> {
    st.offset = up.update_id + 1;
    save();
    const m = up.message;
    if (!m || m.from?.is_bot) return;
    const text = m.text?.trim() ?? "";
    const [head = "", ...rest] = text.split(/\s+/);
    const [cmd = "", at] = head.startsWith("/") ? head.slice(1).toLowerCase().split("@") : [""];
    if (at && (!me || at !== me.toLowerCase())) return; // a command for another bot
    if (cmd === "ack" && d.alertChat !== undefined && m.chat?.id === d.alertChat) {
      try {
        await ack(m, rest.join(" "));
      } catch (e) {
        log("ack error", sentence(e));
      }
      return;
    }
    if (m.chat?.id !== chat) return;
    if (!head.startsWith("/")) {
      if (m.reply_to_message) await reply(m);
      return;
    }
    if (!KNOWN.has(cmd)) return;
    const key = `${cmd} ${rest.join(" ")}`;
    if (now() - (lastCmd.get(key) ?? 0) < SAME_COMMAND_MS) return; // the same command twice in a row: answer once
    lastCmd.set(key, now());
    try {
      await command(cmd, rest.join(" "));
    } catch (e) {
      log("command error", cmd, sentence(e));
    }
  }

  async function setup(): Promise<void> {
    try {
      me = await tg.me();
    } catch (e) {
      log("getMe failed", sentence(e));
    }
    try {
      await tg.setCommands(chat, MENU);
    } catch (e) {
      log("setMyCommands failed", sentence(e));
    }
  }

  async function pollOnce(timeoutSec = 25): Promise<void> {
    if (!me) me = await tg.me().catch(() => null); // needed to tell our commands from other bots'
    let ups: TgUpdate[];
    try {
      ups = await tg.updates(st.offset, timeoutSec);
    } catch (e) {
      log("getUpdates", sentence(e));
      await sleep(5000);
      return;
    }
    for (const up of ups) await handle(up);
  }

  function beat(): void {
    try {
      fs.writeFileSync(heartbeatPath(dataDir), new Date(now()).toISOString(), { mode: 0o600 });
      const t = new Date(now());
      fs.utimesSync(heartbeatPath(dataDir), t, t);
    } catch (e) {
      log("heartbeat not written", sentence(e));
    }
  }

  async function tick(): Promise<void> {
    beat();
    for (const step of [inboxTick, alarmTick, watchRelease, boardPosterTick, summaryTick, () => boardTick()]) {
      try {
        await step();
      } catch (e) {
        log("tick error", sentence(e));
      }
    }
  }

  let running = false;
  /** Runs until stop(): polling for commands, and a tick every 10 seconds. */
  function start(): { stop: () => void } {
    running = true;
    fs.mkdirSync(inboxDir(dataDir), { recursive: true, mode: 0o700 });
    log(`up: ${book.total} updates, ${st.armedAt ? `armed for ${st.armedAt}` : "not armed"}; posts only what the release system reports`);
    void (async () => {
      await setup();
      while (running) await pollOnce();
    })();
    void (async () => {
      await boardTick(true);
      while (running) {
        await tick();
        await sleep(TICK_MS);
      }
    })();
    return { stop: () => void (running = false) };
  }

  return { st, inboxTick, alarmTick, watchRelease, boardPosterTick, summaryTick, boardTick, handle, setup, pollOnce, tick, start, held: () => held(st, book) };
}

export type Teambot = ReturnType<typeof createTeambot>;
