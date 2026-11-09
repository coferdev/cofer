/**
 * Server commands for the team bot. On the server, run through the cofer-release shortcut
 * (docs/teambot.md), as the user that runs the services, from the services folder so its .env is read:
 *
 *   cd services && bun scripts/teambot.ts status
 *   cd services && bun scripts/teambot.ts pause "planned check"
 *
 * Commands: arm, disarm, pause, resume, hold, release, verify, preflight [--post], test, status
 * (see src/teambot/cli.ts). It refuses to do anything where the team bot may not run
 * (TEAMBOT_ENABLED=1 on mainnet only), so it can never post from the testnet service.
 */
import { env } from "../src/env";
import { loadBook } from "../src/teambot/data";
import { githubClient } from "../src/teambot/github";
import { runCli, USAGE } from "../src/teambot/cli";
import { teambotDecision } from "../src/teambot/settings";
import { telegramClient } from "../src/teambot/telegram";

const args = process.argv.slice(2);
if (!args.length || args[0] === "help") {
  console.log(USAGE);
  process.exit(0);
}
const d = teambotDecision(env());
if (!d.run) {
  console.error(`teambot: not available here. ${d.reason}`);
  process.exit(1);
}
const s = d.settings;
try {
  const book = loadBook(s.dataDir);
  const gh = githubClient({ repo: book.repo, token: s.githubToken });
  const code = await runCli(args, {
    book,
    chat: s.chat,
    testChat: s.testChat,
    tg: telegramClient(s.token),
    gate: { githubMode: s.githubMode, changelog: () => gh.changelog(), releases: (fresh) => gh.releases(fresh) },
    out: (line) => console.log(line),
    by: process.env.SUDO_USER || process.env.USER || "server",
  });
  process.exit(code);
} catch (e) {
  console.error(`teambot: ${e instanceof Error ? e.message : "failed"}`);
  process.exit(1);
}
