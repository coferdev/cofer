/**
 * The team bot at work, on the existing alert bot in the staff group (same behaviour and wording
 * as the standalone version it replaces):
 *   - each update at its hour (launch + (N - 1) hours): the gate, then its GitHub release published
 *     if it is a draft, then two copy-ready posts (square poster + Telegram text, wide poster + X text)
 *   - an update that fails the gate is HELD with plain reasons, never posted; the next stays on time
 *   - after a pause, overdue updates go one at a time, 2 minutes apart
 *   - one pinned launch board, edited in place
 *   - staff-group commands (/status /next /schedule /poster /changelog /roadmap /contracts /socials
 *     /videos /video /health /help), only in the staff group, ignoring other bots
 *   - server commands (arm, disarm, pause, resume, hold, release, verify) arrive as files in
 *     TEAMBOT_DATA_DIR/inbox, written by scripts/teambot.ts; never as Telegram commands
 * Everything that has gone out is saved in state.json before and after each post, so a restart
 * neither repeats nor skips one.
 */
import fs from "node:fs";
import path from "node:path";
import { redact } from "../core/errors";
import { pad, posterPath, roadmapPath, tag, type Book, type Update } from "./data";
import { gate, type GateDeps } from "./gate";
import type { GitHub } from "./github";
import {
  allLiveText,
  armedText,
  boardKey,
  boardText,
  changelogReply,
  contractsText,
  currentDay,
  days,
  disarmedText,
  healthText,
  heldText,
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
  resumedText,
  roadmapCaption,
  scheduleDay,
  socialsText,
  tgCopy,
  videosText,
  videoUsage,
  xCopy,
  headingText,
  type HealthRow,
} from "./messages";
import { dueNow, held, loadState, nextDue, released, saveState, us, type State } from "./state";
import type { Tg, TgUpdate } from "./telegram";
import { parseUtc, slotTime } from "./time";

export const TICK_MS = 10_000;
const BOARD_REFRESH_MS = 5 * 60_000;
const SAME_COMMAND_MS = 5_000;
export const CONTROL_COMMANDS = ["arm", "disarm", "pause", "resume", "hold", "release", "verify"] as const;
export type ControlCommand = (typeof CONTROL_COMMANDS)[number];
export const KNOWN = new Set(["help", "start", "status", "next", "schedule", "poster", "changelog", "roadmap", "contracts", "socials", "videos", "video", "health"]);

export interface Control {
  id: string;
  cmd: string;
  arg?: string;
  rest?: string;
  by?: string;
}

export interface TeambotDeps {
  book: Book;
  tg: Tg;
  gh: GitHub;
  chat: number; // the staff group
  githubMode: "publish" | "check" | "off";
  now?: () => number;
  log?: (...a: unknown[]) => void;
  posterExists?: (p: string) => boolean;
  fetch?: typeof fetch; // for /health
  sleep?: (ms: number) => Promise<void>;
}

export const inboxDir = (dataDir: string) => path.join(dataDir, "inbox");
const sentence = (e: unknown) => {
  const m = redact(e instanceof Error ? e.message : String(e));
  return m.endsWith(".") ? m : `${m}.`;
};

export function createTeambot(d: TeambotDeps) {
  const { book, tg, chat } = d;
  const now = d.now ?? Date.now;
  const log = d.log ?? ((...a: unknown[]) => console.log("[teambot]", ...a.map((x) => redact(String(x)))));
  const sleep = d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const dataDir = book.dataDir;
  const st: State = loadState(dataDir);
  const save = () => saveState(dataDir, st);
  const say = (html: string) => tg.send(chat, html);
  const slot = (n: number) => slotTime(st.armedAt!, n, book.slotMs);
  const gateDeps: GateDeps = { githubMode: d.githubMode, changelog: () => d.gh.changelog(), releases: (fresh) => d.gh.releases(fresh), posterExists: d.posterExists };

  // ---------------- releasing one update ----------------
  async function hold(u: Update, why: string[], kind = "HELD", dot = "🟡"): Promise<void> {
    const reason = why.join(" ");
    const s = us(st, u.n);
    if (s.state === "held" && s.reason === reason) return; // one message per real change
    Object.assign(s, { state: "held", reason, at: new Date(now()).toISOString() });
    save();
    await say(heldText(u, reason, nextDue(st, book), kind, dot));
  }

  async function doRelease(u: Update): Promise<void> {
    const s = us(st, u.n);
    const { why, rel } = await gate(st, book, u, gateDeps, true);
    if (why.length) return hold(u, why);
    s.state = "posting";
    save();
    if (d.githubMode === "publish" && rel?.draft) {
      try {
        await d.gh.publish(rel.id);
      } catch (e) {
        const status = (e as { status?: number }).status;
        return hold(u, [status ? `GitHub refused to publish the release ${tag(u.n)} (${status}).` : `GitHub could not be reached to publish the release ${tag(u.n)}.`], "FAILED", "🔴");
      }
    }
    if (u.n === 1 && !st.launchedPosted) {
      await say(launchedText(st, book));
      st.launchedPosted = true;
      save();
    }
    if (!s.head && !s.tg) {
      s.head = await say(headingText(u.n));
      save();
    }
    if (!s.tg) {
      s.tg = await tg.photo(chat, posterPath(book, u.n, "square"), tgCopy(book, u));
      save();
    }
    if (!s.x) {
      s.x = await tg.photo(chat, posterPath(book, u.n, "wide"), xCopy(u));
      save();
    }
    Object.assign(s, { state: "released", reason: null, at: new Date(now()).toISOString() });
    st.lastReleaseAt = now();
    save();
    log("released", tag(u.n));
    if (released(st, book).length === book.total && !st.finishedPosted) {
      st.finishedPosted = true;
      save();
      await say(allLiveText(book, now()));
    }
  }

  async function releaseTick(): Promise<void> {
    if (!st.armedAt || st.paused) return;
    const due = dueNow(st, book, now());
    if (!due.length) return;
    if (now() - st.lastReleaseAt < book.catchupMs) return; // behind schedule: one at a time, a little apart
    try {
      await doRelease(due[0]!);
    } catch (e) {
      log("release error", sentence(e));
      await hold(due[0]!, [sentence(e)], "FAILED", "🔴").catch((e2) => log("could not report", sentence(e2)));
    }
  }

  // ---------------- the pinned board ----------------
  let lastBoard = { key: "", at: 0 };
  async function boardTick(force = false): Promise<void> {
    const text = boardText(st, book, now());
    const key = boardKey(text);
    if (!force && key === lastBoard.key && now() - lastBoard.at < BOARD_REFRESH_MS) return;
    try {
      if (st.board) {
        try {
          await tg.edit(chat, st.board, text);
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

  // ---------------- server commands ----------------
  async function applyControl(c: Control): Promise<string> {
    const n = parseInt(c.arg ?? "", 10);
    const u = book.byN.get(n);
    switch (c.cmd) {
      case "arm": {
        const t = parseUtc(c.arg);
        if (!t) return 'Could not read that time. Use: cofer-release arm "2026-11-30 18:00" (UTC).';
        if (released(st, book).length) return "Updates have already gone out. The launch time can no longer change.";
        if (t.getTime() <= now()) return "That time has already passed. Pick a time in the future (UTC).";
        const changed = !!st.armedAt;
        st.armedAt = t.toISOString();
        save();
        await say(armedText(changed, t, book));
        for (let day = 1; day <= days(book); day++) await say(scheduleDay(st, book, day)!);
        return `Armed for ${t.toISOString()} (UTC). The schedule was posted in the group.`;
      }
      case "disarm":
        if (!st.armedAt) return "Not armed. Nothing changed.";
        if (released(st, book).length) return "Updates have already gone out; use pause instead.";
        st.armedAt = null;
        save();
        await say(disarmedText());
        return "Disarmed.";
      case "pause": {
        if (st.paused) return `Already paused (${st.paused.reason}). Nothing changed.`;
        st.paused = { reason: c.arg || "planned pause", at: new Date(now()).toISOString(), by: c.by };
        save();
        await say(pausedText(st.paused.reason));
        return "Paused.";
      }
      case "resume": {
        if (!st.paused) return "Not paused. Nothing changed."; // never a RESUMED without a PAUSED
        st.paused = null;
        save();
        await say(resumedText(st, book, dueNow(st, book, now()).length));
        return "Resumed.";
      }
      case "hold":
        if (!u) return 'Usage: cofer-release hold 15 "reason"';
        if (st.u[n]?.state === "released") return `Update ${n} is already out.`;
        await hold(u, [`Held from the server: ${c.rest || "no reason given"}.`]);
        return `Update ${n} is held.`;
      case "release":
        if (!u) return "Usage: cofer-release release 15";
        if (st.u[n]?.state !== "held") return `Update ${n} is not held. Nothing changed.`;
        st.u[n]!.state = null;
        st.u[n]!.reason = null;
        save();
        return `Update ${n} is no longer held. Its checks run again before it goes out${st.armedAt && slot(n).getTime() <= now() ? " (it is overdue, so it goes out shortly)" : ""}.`;
      case "verify":
        if (!u) return "Usage: cofer-release verify 23";
        us(st, n).verified = true;
        save();
        return `Update ${n} is marked as checked.`;
      default:
        return `Unknown command: ${c.cmd}`;
    }
  }

  async function inboxTick(): Promise<void> {
    const dir = inboxDir(dataDir);
    if (!fs.existsSync(dir)) return;
    for (const f of fs
      .readdirSync(dir)
      .filter((x) => x.endsWith(".json"))
      .sort()) {
      const p = path.join(dir, f);
      let c: Control;
      try {
        c = JSON.parse(fs.readFileSync(p, "utf8")) as Control;
        if (typeof c.id !== "string" || !/^[\w-]{1,64}$/.test(c.id) || typeof c.cmd !== "string") throw new Error("bad");
      } catch {
        fs.rmSync(p, { force: true });
        continue;
      }
      let text: string;
      try {
        text = await applyControl(c);
      } catch (e) {
        text = `Failed: ${sentence(e)}`;
      }
      st.lastControl = { id: c.id, text };
      save();
      fs.rmSync(p, { force: true });
      log("control", c.cmd, c.arg ?? "", "->", text);
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
          if ((d.posterExists ?? fs.existsSync)(p)) await tg.photo(chat, p, posterCaption(n, shape === "wide"));
        }
        return;
      }
      case "changelog":
        return say(changelogReply(st, book));
      case "roadmap": {
        const cap = roadmapCaption(st, book);
        const img = roadmapPath(book);
        return img && (d.posterExists ?? fs.existsSync)(img) ? tg.photo(chat, img, cap, true) : say(cap);
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
  /** One update from Telegram: answered only if it is one of our commands, in the staff group, from a person. */
  async function handle(up: TgUpdate): Promise<void> {
    st.offset = up.update_id + 1;
    save();
    const m = up.message;
    if (!m?.text || m.chat?.id !== chat || !m.text.startsWith("/") || m.from?.is_bot) return;
    const [head, ...rest] = m.text.trim().split(/\s+/);
    const [cmd = "", at] = head!.slice(1).toLowerCase().split("@");
    if (at && (!me || at !== me.toLowerCase())) return; // a command for another bot
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

  async function tick(): Promise<void> {
    try {
      await inboxTick();
      await releaseTick();
      await boardTick();
    } catch (e) {
      log("tick error", sentence(e));
    }
  }

  let running = false;
  /** Runs until stop(): polling for commands, and a tick every 10 seconds. */
  function start(): { stop: () => void } {
    running = true;
    fs.mkdirSync(inboxDir(dataDir), { recursive: true, mode: 0o700 });
    log(`up: ${book.total} updates, GitHub ${d.githubMode}, ${st.armedAt ? `armed for ${st.armedAt}` : "not armed"}`);
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

  return { st, releaseTick, boardTick, inboxTick, applyControl, handle, setup, pollOnce, tick, start, held: () => held(st, book) };
}

export type Teambot = ReturnType<typeof createTeambot>;
