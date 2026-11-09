/**
 * Every message the team bot posts in the staff group, with its exact wording. HTML (Telegram
 * parse_mode HTML) except the two copy-ready post captions, which are plain text. Pure: the
 * current time is passed in.
 */
import { pad, relUrl, tag, type Book, type Update } from "./data";
import { held, nextDue, released, type State } from "./state";
import { dayLabel, inMins, slotTime, three, threeShort, utcClock } from "./time";

export const esc = (s: unknown) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const TYPE: Record<string, string> = { NEW: "New", HOW: "How it works", CMD: "Command", BTS: "Behind the scenes" };
const slot = (st: State, book: Book, n: number) => slotTime(st.armedAt!, n, book.slotMs);
const releasesUrl = (book: Book) => `https://github.com/${book.repo}/releases`;

// ---------------- incidents ----------------

export interface IncidentFields {
  what?: string;
  users?: string;
  done?: string;
  next?: string;
}

/** "🟡 <b>HELD · Update 15</b>", a blank line, then What happened / Users affected / What we did / Next. */
export function incident(dot: string, kind: string, subject: string, f: IncidentFields): string {
  const rows: [string, string | undefined][] = [
    ["What happened", f.what],
    ["Users affected", f.users ?? "No. Cofer keeps running."],
    ["What we did", f.done],
    ["Next", f.next],
  ];
  return `${dot} <b>${esc(kind)} · ${esc(subject)}</b>\n\n${rows
    .filter((r) => r[1])
    .map(([k, v]) => `<b>${k}:</b> ${esc(v)}`)
    .join("\n")}`;
}

/** An update kept back (HELD, 🟡) or one that broke while posting (FAILED, 🔴). */
export function heldText(u: Update, reason: string, next: Update | undefined, kind = "HELD", dot = "🟡"): string {
  return incident(dot, kind, `Update ${pad(u.n)}`, {
    what: reason,
    done: `Update ${pad(u.n)} is held and nothing about it was posted.${next ? ` Update ${pad(next.n)} stays on time.` : ""}`,
    next: `Fix the above, then on the server run: cofer-release release ${u.n}`,
  });
}

export function launchedText(st: State, book: Book): string {
  const nx = book.updates[1];
  return `🟢 <b>COFER IS LAUNCHED</b>\n\nUpdate 1 of ${book.total} is live on Robinhood Chain mainnet.\n\n• GitHub release published: <a href="${relUrl(book, 1)}">${tag(1)}</a>\n• The Telegram and X posts follow below.\n\n${
    nx ? `<b>Next:</b> Update ${pad(nx.n)} at ${three(slot(st, book, nx.n))}, then one every hour until ${dayLabel(slot(st, book, book.total))}, ${utcClock(slot(st, book, book.total))} UTC.` : ""
  }`;
}

export function allLiveText(book: Book, now: number): string {
  return `🏁 <b>ALL ${book.total} UPDATES ARE LIVE</b>\n\nThe last one, Update ${pad(book.total)}, went out at ${three(new Date(now))}.\nEvery release: <a href="${releasesUrl(book)}">github.com/${book.repo}/releases</a>`;
}

export function armedText(changed: boolean, t: Date, book: Book): string {
  return `🟢 <b>${changed ? "LAUNCH TIME CHANGED" : "SCHEDULE ARMED"}</b>\n\n<b>Launch:</b> ${dayLabel(t)}, ${three(t)}\n${book.total} updates, one every hour. Update 1 goes out at that minute.\nEach update goes out only after its checks pass. One that fails is held, never posted broken.`;
}

export const disarmedText = () =>
  incident("⏸", "SCHEDULE CANCELLED", "launch", { what: "The launch time was cleared from the server.", done: "No update will go out until a new launch time is set.", next: "A new time will be posted here." });

export const pausedText = (reason: string) =>
  incident("⏸", "PAUSED", "updates", { what: `Updates were paused from the server: ${reason}.`, done: "No new update goes out. One already posting finishes.", next: "A resume will be posted here." });

/** `overdue` updates are waiting; `next` is the next one when none are. */
export function resumedText(st: State, book: Book, overdue: number): string {
  const mins = Math.round(book.catchupMs / 60000);
  const nx = st.armedAt ? nextDue(st, book) : undefined;
  const next = overdue
    ? `${overdue} overdue update${overdue > 1 ? "s go" : " goes"} out first${overdue > 1 ? `, ${Math.max(1, mins)} minute${mins > 1 ? "s" : ""} apart` : ""}, then the normal times.`
    : nx
      ? `Update ${pad(nx.n)} at ${three(slot(st, book, nx.n))}.`
      : "Nothing is waiting.";
  return incident("▶️", "RESUMED", "updates", { what: "The pause ended.", done: "Updates continue.", next });
}

export function preflightText(bad: [Update, string[]][], total: number): string {
  const ok = total - bad.length;
  return bad.length
    ? `🟡 <b>PREFLIGHT · ${ok} of ${total} ready</b>\n\n${bad.map(([u, why]) => `<b>${pad(u.n)}</b> ${esc(why.join(" "))}`).join("\n")}\n\n<i>Each one is held at its hour unless fixed.</i>`
    : `🟢 <b>PREFLIGHT ALL CLEAR</b>\n\n${total} of ${total} updates are ready: status checked, posters on the server, changelog lines and GitHub releases in place.`;
}

// ---------------- the two copy-ready posts (plain text captions) ----------------

/** Under the square poster: ready to paste into the Telegram channel. */
export const tgCopy = (book: Book, u: Update) => `Update ${pad(u.n)} of ${book.total}\n\n${u.telegram}\n\nGitHub: ${relUrl(book, u.n)}`;

/** Sent just before an update's two posts. */
export function headingText(n: number): string {
  return `<b>Tech Updates: Update ${pad(n)} Released</b>`;
}

/** Under the wide poster: ready to paste into X, with its length. */
export function xCopy(u: Update): string {
  const text = `Update ${pad(u.n)}: ${u.x}`;
  return `For X · ${text.length} characters\n\n${text}`;
}

// ---------------- the pinned board ----------------

export function boardText(st: State, book: Book, now: number): string {
  const total = book.total;
  const done = released(st, book).length;
  const cells = 12;
  const fill = Math.round((done / total) * cells);
  const bar = "▰".repeat(fill) + "▱".repeat(cells - fill);
  const nx = st.armedAt ? nextDue(st, book) : undefined;
  const h = held(st, book).map((u) => pad(u.n));
  let queue = "○ not armed";
  if (st.armedAt) queue = st.paused ? `⏸ paused: ${st.paused.reason}` : done === total ? "✓ finished" : now < Date.parse(st.armedAt) ? "◷ armed" : "● running";
  const lines = [`Live    ${String(done).padStart(2)} / ${total}   ${bar}`];
  if (nx) {
    const t = slot(st, book, nx.n);
    lines.push(`Next    Update ${pad(nx.n)} · ${TYPE[nx.type] || ""}`, `        ${threeShort(t)}`, `        ${dayLabel(t)} · ${inMins(t, now)}`);
  } else if (!st.armedAt) lines.push("Next    launch time not set");
  lines.push(`Queue   ${queue}`, `Held    ${h.length ? h.join(", ") : "none"}`);
  const last = released(st, book).sort((a, b) => Date.parse(st.u[b.n]!.at!) - Date.parse(st.u[a.n]!.at!))[0];
  let out = `<b>COFER LAUNCH BOARD</b>\n<pre>${esc(lines.join("\n"))}</pre>`;
  if (last) out += `\n<b>Last:</b> Update ${pad(last.n)} · ${esc(last.title)}\n<a href="${relUrl(book, last.n)}">${esc(`github.com/${book.repo}/releases/tag/${tag(last.n)}`)}</a>`;
  out += `\n\n<i>Times: UTC · Moscow · New York. Updated ${utcClock(new Date(now))} UTC.</i>`;
  return out;
}

/** The board without its "Updated" time, to tell whether anything real changed. */
export const boardKey = (text: string) => text.replace(/Updated \d\d:\d\d UTC/, "");

// ---------------- schedule ----------------

/** The list for day d (24 updates a day), or null if there is no such day. */
export function scheduleDay(st: State, book: Book, d: number): string | null {
  const list = book.updates.filter((u) => Math.ceil(u.n / 24) === d);
  if (!list.length) return null;
  const first = slot(st, book, list[0]!.n);
  const rows = list.map((u) => {
    const s = st.u[u.n]?.state;
    const mark = s === "released" ? "✓" : s === "held" ? "⏸" : " ";
    return `<code>${pad(u.n)}${mark}</code> ${threeShort(slot(st, book, u.n))}  ${esc(u.title)}`;
  });
  return `<b>Day ${d} · from ${dayLabel(first)}</b>\n<i>UTC · Moscow · New York</i>\n\n${rows.join("\n")}`;
}

export const days = (book: Book) => Math.ceil(book.total / 24);

/** Today's day number since launch (1 before launch), capped at the last day. */
export function currentDay(st: State, book: Book, now: number): number {
  return Math.min(days(book), Math.max(1, Math.floor((now - Date.parse(st.armedAt!)) / (24 * book.slotMs)) + 1));
}

// ---------------- staff-group command replies ----------------

export const HELP = `<b>Cofer team bot</b>

/status  the launch board
/next  the next 3 updates and when
/schedule 1  the day 1 list (2, 3)
/poster 14  both posters of a released update
/changelog  the latest releases
/roadmap  the roadmap
/contracts  every contract, with explorer links
/socials  our links
/videos  the demo videos, then /video 3
/health  is everything up

<i>Pause, resume and hold are done from the server only.</i>`;

/** The command menu shown in the staff group (setMyCommands). */
export const MENU: [string, string][] = [
  ["status", "the launch board"],
  ["next", "the next 3 updates"],
  ["schedule", "a day of updates"],
  ["poster", "posters of a released update"],
  ["changelog", "latest releases"],
  ["roadmap", "the roadmap"],
  ["contracts", "contracts and links"],
  ["socials", "our links"],
  ["videos", "demo videos"],
  ["health", "is everything up"],
  ["help", "all commands"],
];

export const NOT_SET = "The launch time is not set yet.";

export function nextText(st: State, book: Book, now: number): string {
  if (!st.armedAt) return NOT_SET;
  const list = book.updates.filter((u) => st.u[u.n]?.state !== "released").slice(0, 3);
  if (!list.length) return `All ${book.total} updates are live.`;
  return `<b>Next updates</b>\n<i>UTC · Moscow · New York</i>\n\n${list
    .map((u) => `<b>${pad(u.n)}</b> · ${esc(u.title)}\n${threeShort(slot(st, book, u.n))} · ${inMins(slot(st, book, u.n), now)}${st.u[u.n]?.state === "held" ? " · ⏸ held" : ""}`)
    .join("\n\n")}`;
}

export const noDayText = (d: number) => `There is no day ${d}. Try /schedule 1.`;
export const posterUsage = "Send it with a number, like /poster 14.";
export const posterNotLive = (n: number) => `Update ${pad(n)} is not live yet. Its posters are shared here at its hour.`;
export const posterCaption = (n: number, wide: boolean) => `Update ${pad(n)} · ${wide ? "wide, for X" : "square, for Telegram and Instagram"}`;

export function changelogReply(st: State, book: Book): string {
  const last = released(st, book)
    .sort((a, b) => b.n - a.n)
    .slice(0, 3);
  if (!last.length) return `Nothing released yet. All releases will be at github.com/${book.repo}/releases`;
  return `<b>Latest releases</b>\n\n${last.map((u) => `<b>${pad(u.n)}</b> · ${esc(u.title)}\n<a href="${relUrl(book, u.n)}">${tag(u.n)}</a>`).join("\n\n")}\n\nAll: <a href="${releasesUrl(book)}">github.com/${book.repo}/releases</a>`;
}

export function roadmapCaption(st: State, book: Book): string {
  const lines: string[] = [];
  for (let d = 1; d <= days(book); d++) {
    const a = (d - 1) * 24 + 1;
    const b = Math.min(d * 24, book.total);
    const live = released(st, book).filter((u) => u.n >= a && u.n <= b).length;
    lines.push(`<b>Day ${d}</b> · updates ${a} to ${b} · ${live} live`);
  }
  return `<b>Roadmap</b>\n${book.total} updates, one every hour.\n\n${lines.join("\n")}\n\n/schedule 1 for a full day.`;
}

export function contractsText(book: Book): string {
  const { cfg } = book;
  return `<b>Cofer contracts</b>\nRobinhood Chain mainnet, chain 4663\n\n${cfg.contracts
    .map(
      (c) =>
        `<b>${esc(c.name)}</b>\n<code>${c.address}</code>\n<a href="${esc(cfg.explorer)}/address/${c.address}">explorer</a>${c.sourcify ? ` · <a href="https://repo.sourcify.dev/4663/${c.address}">source verified</a>` : ""}`,
    )
    .join("\n\n")}`;
}

export const socialsText = (book: Book) => `<b>Cofer links</b>\n\n${book.cfg.socials.map((s) => `<b>${esc(s.name)}:</b> ${esc(s.url)}`).join("\n")}`;

export const videosText = (book: Book) =>
  `<b>Demo videos</b>\n<i>Desktop, on testnet with test USDG</i>\n\n${book.cfg.videos.map((v, i) => `${i + 1}. ${esc(v.title)}`).join("\n")}\n\nSend /video 3 to get one.`;

export const videoUsage = (book: Book) => `Send it with a number from 1 to ${book.cfg.videos.length}, like /video 3.`;

export interface HealthRow {
  name: string;
  status?: number; // missing = no answer
  ok?: boolean;
  ms?: number;
}

export function healthText(rows: HealthRow[], st: State, now: number): string {
  const lines = rows.map((r) => (r.status === undefined ? `❌ ${esc(r.name)} · no answer` : `${r.ok ? "✅" : "❌"} ${esc(r.name)} · ${r.status} · ${r.ms} ms`));
  const q = !st.armedAt ? "not armed" : st.paused ? `paused (${esc(st.paused.reason)})` : "running";
  return `<b>Health</b>\n\n${lines.join("\n")}\n\nUpdates: ${q}\n<i>Checked ${three(new Date(now))}</i>`;
}

/** The board as plain text, for the server's "status" command. */
export const plainText = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
