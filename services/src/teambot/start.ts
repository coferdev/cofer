/**
 * Starts the team bot in the keeper, only where teambot/settings.ts allows it (TEAMBOT_ENABLED=1 on
 * mainnet, with the alert bot, the staff group and a private data folder). Never throws: if it
 * cannot start, the reason is logged and the keeper and the alerts carry on.
 */
import type { Env } from "../env";
import { logError } from "../core/errors";
import { loadBook } from "./data";
import { githubClient } from "./github";
import { createTeambot } from "./runner";
import { teambotDecision } from "./settings";
import { telegramClient } from "./telegram";

export function maybeStartTeambot(e: Env): { stop: () => void } | null {
  const d = teambotDecision(e);
  if (!d.run) {
    if (d.enabled) logError("teambot", new Error(`not started: ${d.reason}`));
    return null;
  }
  try {
    const s = d.settings;
    const book = loadBook(s.dataDir);
    const bot = createTeambot({
      book,
      tg: telegramClient(s.token),
      gh: githubClient({ repo: book.repo, token: s.githubToken }),
      chat: s.chat,
      githubMode: s.githubMode,
    });
    return bot.start();
  } catch (err) {
    logError("teambot", new Error(`not started: ${err instanceof Error ? err.message : "unknown error"}`));
    return null;
  }
}
