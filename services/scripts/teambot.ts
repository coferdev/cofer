/**
 * The team bot's read-only server command. On the server, as the user that runs the services, from
 * the services folder so its .env is read:
 *
 *   cd services && bun scripts/teambot.ts status
 *
 * Launch commands (arm, pause, hold, release, ...) belong to the release system (cofer-release).
 * It refuses to run where the team bot may not run (TEAMBOT_ENABLED=1 on mainnet only).
 */
import { env } from "../src/env";
import { loadBook } from "../src/teambot/data";
import { runCli, USAGE } from "../src/teambot/cli";
import { teambotDecision } from "../src/teambot/settings";

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
try {
  process.exit(runCli(args, { book: loadBook(d.settings.dataDir), out: (line) => console.log(line) }));
} catch (e) {
  console.error(`teambot: ${e instanceof Error ? e.message : "failed"}`);
  process.exit(1);
}
