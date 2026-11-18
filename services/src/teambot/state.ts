/**
 * What the team bot has done, in TEAMBOT_DATA_DIR/state.json. Written after every step that
 * posts something (to a temporary file, flushed, then renamed over the old one), so a restart
 * neither repeats nor skips a post.
 */
import fs from "node:fs";
import path from "node:path";
import type { Book, Update } from "./data";

export type UpdateStateName = "posting" | "held" | "rolled_back" | "delayed" | "released" | null;

export interface UpdateState {
  state?: UpdateStateName;
  reason?: string | null;
  at?: string; // when it was released or held (ISO)
  verified?: boolean; // marked checked from the server
  head?: number; // message id of the heading sent before the two posts, once sent
  tg?: number; // message id of the Telegram post (square poster), once sent
  x?: number; // message id of the X post (wide poster), once sent
  zipSq?: number; // message id of the square poster's zip, once sent
  zipX?: number; // message id of the wide poster's zip, once sent
  lines?: Partial<Record<StatusKind, number>>; // message id of each status line posted for this update
  lastNotice?: string; // the last held / delayed / rolled-back notice posted for it
}

/** The four outcomes the release system reports. */
export type StatusKind = "released" | "delayed" | "held" | "rolled_back";

/** A release emergency open in Alert Test (repeated every 2 minutes until it clears). */
export interface Alarm {
  name: string;
  what: string;
  who: string;
  n?: number; // the update it is about
  postAt?: string; // that update's posting time (ISO)
  openedAt: number; // ms
  lastSentAt: number; // ms; 0 = not sent yet
  ackUntil: number; // ms; repeats pause until then
  messages: number[]; // message ids sent for it (a reply to any of them is an /ack for it)
  own?: boolean; // raised by the team bot itself (the release system's heartbeat)
}

export interface State {
  armedAt: string | null; // launch time (ISO, UTC)
  paused: { reason: string; at: string; by?: string } | null;
  board: number | null; // message id of the pinned board
  offset: number; // next Telegram update id to read
  u: Record<string, UpdateState>;
  lastReleaseAt: number; // ms
  launchedPosted: boolean;
  finishedPosted: boolean;
  lastControl: { id: string; text: string } | null; // answer to the last server command
  seen: string[]; // ids of release-system notices already handled (a notice delivered twice posts once)
  alarms: Record<string, Alarm>; // open release emergencies, by name
  boardPoster: { dueAt: number; live: number } | null; // the board poster due 30 minutes after a release
  summaryDays: string[]; // UTC days whose "Shipped today" went out
  retryAt: number; // ms: a notice that failed to post is tried again from then
}

export const blankState = (): State => ({ armedAt: null, paused: null, board: null, offset: 0, u: {}, lastReleaseAt: 0, launchedPosted: false, finishedPosted: false, lastControl: null, seen: [], alarms: {}, boardPoster: null, summaryDays: [], retryAt: 0 });

export const statePath = (dataDir: string) => path.join(dataDir, "state.json");

/** The saved state, or a blank one if there is none yet. A file that cannot be read stops the bot rather than starting over. */
export function loadState(dataDir: string): State {
  const p = statePath(dataDir);
  if (!fs.existsSync(p)) return blankState();
  try {
    return { ...blankState(), ...(JSON.parse(fs.readFileSync(p, "utf8")) as Partial<State>) };
  } catch {
    throw new Error("state.json in the data folder could not be read. Fix or restore it before starting (starting blank could post updates twice).");
  }
}

export function saveState(dataDir: string, st: State): void {
  const p = statePath(dataDir);
  const tmp = `${p}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(st, null, 1));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, p);
}

export const us = (st: State, n: number): UpdateState => (st.u[n] ||= {});
export const released = (st: State, book: Book): Update[] => book.updates.filter((u) => st.u[u.n]?.state === "released");
/** Held at its hour or rolled back (shown together as "Held" on the board). */
export const held = (st: State, book: Book): Update[] => book.updates.filter((u) => ["held", "rolled_back"].includes(st.u[u.n]?.state ?? ""));
const waiting = (st: State, n: number) => !["released", "held", "rolled_back"].includes(st.u[n]?.state ?? "");
/** The first update that is neither out nor held. */
export const nextDue = (st: State, book: Book): Update | undefined => book.updates.find((u) => waiting(st, u.n));
