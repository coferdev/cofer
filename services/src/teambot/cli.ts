/**
 * The team bot's own server command (scripts/teambot.ts): read-only. Every launch command (arm,
 * disarm, pause, resume, hold, release, verify, preflight, test) belongs to the release system,
 * which does the work and tells the team bot what to post (see notices.ts); on the server they run
 * through the cofer-release shortcut, which points at the release system.
 *
 *   status    print the board as it stands, the held updates and the open emergencies
 */
import { pad, type Book } from "./data";
import { boardText, plainText } from "./messages";
import { held, loadState } from "./state";

export const USAGE = "Usage: bun scripts/teambot.ts status   (launch commands: cofer-release, the release system)";

export interface CliDeps {
  book: Book;
  out: (line: string) => void;
  now?: () => number;
}

/** Runs one read-only command; returns the exit code. */
export function runCli(args: string[], d: CliDeps): number {
  const [cmd] = args;
  if (cmd !== "status") {
    d.out(USAGE);
    return cmd === undefined || cmd === "help" ? 0 : 2;
  }
  const st = loadState(d.book.dataDir);
  d.out(plainText(boardText(st, d.book, (d.now ?? Date.now)())));
  for (const u of held(st, d.book)) d.out(`held ${pad(u.n)}: ${st.u[u.n]!.reason}`);
  for (const a of Object.values(st.alarms)) d.out(`emergency open: ${a.name}: ${a.what}`);
  return 0;
}
