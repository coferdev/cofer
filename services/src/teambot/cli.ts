/**
 * Server commands for the team bot (scripts/teambot.ts; on the server through the cofer-release
 * shortcut). Never Telegram commands.
 *
 *   arm "2026-11-30 18:00"   launch time, in UTC
 *   disarm                   cancel before launch
 *   pause "reason"           stop new updates (one already posting finishes)
 *   resume                   continue (overdue updates go one at a time, 2 minutes apart)
 *   hold 15 "reason"         keep one update back
 *   release 15               let a held update go (its checks run again first)
 *   verify 23                mark a RECHECK update as checked
 *   preflight [--post]       check every update now; --post also reports to the staff group
 *   test 14                  send update 14's heading and two posts to TEAMBOT_TEST_CHAT_ID only
 *   status                   print where things stand
 *
 * The first seven are handed to the running bot (a file in TEAMBOT_DATA_DIR/inbox) and this waits
 * for its answer, so there is only ever one writer of state.json.
 */
import fs from "node:fs";
import path from "node:path";
import { pad, posterPath, type Book } from "./data";
import { gate, type GateDeps } from "./gate";
import { boardText, headingText, plainText, preflightText, tgCopy, xCopy } from "./messages";
import { CONTROL_COMMANDS, inboxDir, type Control } from "./runner";
import { held, loadState } from "./state";
import type { Tg } from "./telegram";

export const USAGE = 'Usage: cofer-release arm "YYYY-MM-DD HH:MM" | disarm | pause "reason" | resume | hold N "reason" | release N | verify N | preflight [--post] | test N | status';
export const NO_ANSWER = "The bot did not answer. Is the mainnet keeper running with TEAMBOT_ENABLED=1?";

export interface CliDeps {
  book: Book;
  chat: number; // staff group
  testChat?: number;
  tg: Tg;
  gate: GateDeps;
  out: (line: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  by?: string; // who ran it (the server user)
  waitTries?: number; // default 40, half a second apart
}

/** Runs one server command; returns the exit code. */
export async function runCli(args: string[], d: CliDeps): Promise<number> {
  const [cmd, ...rest] = args;
  const sleep = d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = d.now ?? Date.now;
  const { book } = d;

  if ((CONTROL_COMMANDS as readonly string[]).includes(cmd ?? "")) {
    const id = `${now()}-${Math.random().toString(36).slice(2, 8)}`;
    const dir = inboxDir(book.dataDir);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${id}.json`);
    const c: Control = { id, cmd: cmd!, arg: rest.join(" "), rest: rest.slice(1).join(" "), by: d.by ?? "server" };
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(c), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file); // the bot never sees a half-written file
    for (let i = 0; i < (d.waitTries ?? 40); i++) {
      await sleep(500);
      const st = loadState(book.dataDir);
      if (st.lastControl?.id === id) {
        d.out(st.lastControl.text);
        return 0;
      }
    }
    fs.rmSync(file, { force: true });
    d.out(NO_ANSWER);
    return 1;
  }

  switch (cmd) {
    case "preflight": {
      const st = loadState(book.dataDir);
      const bad: [(typeof book.updates)[number], string[]][] = [];
      for (const u of book.updates) {
        const { why } = await gate(st, book, u, d.gate);
        if (why.length) bad.push([u, why]);
      }
      for (const [u, why] of bad) d.out(`${pad(u.n)}  ${why.join(" | ")}`);
      d.out(`${book.total - bad.length} of ${book.total} ready${bad.length ? "" : ": all clear"}`);
      if (rest.includes("--post")) await d.tg.send(d.chat, preflightText(bad, book.total));
      return 0;
    }
    case "test": {
      const u = book.byN.get(parseInt(rest[0] ?? "", 10));
      if (d.testChat === undefined) {
        d.out("Set TEAMBOT_TEST_CHAT_ID first (a test group, never the staff group).");
        return 1;
      }
      if (d.testChat === d.chat) {
        d.out("TEAMBOT_TEST_CHAT_ID is the staff group. Use a separate test group.");
        return 1;
      }
      if (!u) {
        d.out("Usage: cofer-release test 14");
        return 1;
      }
      await d.tg.send(d.testChat, headingText(u.n));
      await d.tg.photo(d.testChat, posterPath(book, u.n, "square"), tgCopy(book, u));
      await d.tg.photo(d.testChat, posterPath(book, u.n, "wide"), xCopy(u));
      d.out(`Sent update ${u.n}'s two posts to the test group.`);
      return 0;
    }
    case "status": {
      const st = loadState(book.dataDir);
      d.out(plainText(boardText(st, book, now())));
      for (const u of held(st, book)) d.out(`held ${pad(u.n)}: ${st.u[u.n]!.reason}`);
      return 0;
    }
    default:
      d.out(USAGE);
      return cmd === undefined || cmd === "help" ? 0 : 2;
  }
}
