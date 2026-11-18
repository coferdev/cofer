/**
 * Whether the team bot (update schedule, pinned launch board, staff commands on the alert bot) may
 * run in this process, and with what. It runs only when every one of these holds:
 *   - TEAMBOT_ENABLED=1
 *   - CHAIN_ID is mainnet (4663): the testnet service never posts updates or reads the alert bot
 *   - ALERT_BOT_TOKEN and OPS_CHAT_ID are set (it is the existing alert bot, in the staff group)
 *   - TEAMBOT_DATA_DIR is a full path outside the repo (the repo is public; updates and posters are not)
 *   - TEAMBOT_TEST_CHAT_ID (Alert Test: release emergencies, /ack, test posts) is set and is not the staff group
 *   - TEAMBOT_RELEASE_HEARTBEAT, if set, is a full path (the release system's heartbeat file)
 * The release system does the work and the GitHub release; the team bot only posts, so it holds no GitHub token.
 * When one does not hold, the answer is "off" with a plain reason. It never throws: a wrong team
 * bot setting must not stop the keeper or the alerts.
 */
import fs from "node:fs";
import path from "node:path";
import type { Env } from "../env";

export const TEAMBOT_CHAIN_ID = 4663;

export interface TeambotSettings {
  token: string; // ALERT_BOT_TOKEN (secret)
  chat: number; // OPS_CHAT_ID
  dataDir: string; // resolved, outside the repo
  testChat: number; // Alert Test
  releaseHeartbeat?: string;
}

export type TeambotDecision = { run: true; settings: TeambotSettings } | { run: false; enabled: boolean; reason: string };

type Input = Pick<Env, "TEAMBOT_ENABLED" | "CHAIN_ID" | "ALERT_BOT_TOKEN" | "OPS_CHAT_ID" | "TEAMBOT_DATA_DIR" | "TEAMBOT_TEST_CHAT_ID" | "TEAMBOT_RELEASE_HEARTBEAT">;

/** The repo's top folder (this file is services/src/teambot/settings.ts). */
export const REPO_ROOT = path.resolve(import.meta.dir, "../../..");

/** The real path (symlinks followed) when it exists, else the plain resolved path. */
function realOrResolved(p: string): string {
  const r = path.resolve(p);
  try {
    return fs.realpathSync(r);
  } catch {
    return r;
  }
}

/** True if `dir` is `root` or inside it. */
export function isInside(dir: string, root: string): boolean {
  const rel = path.relative(root, dir);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function teambotDecision(e: Input, o: { repoRoot?: string; realpath?: (p: string) => string } = {}): TeambotDecision {
  const off = (reason: string): TeambotDecision => ({ run: false, enabled: e.TEAMBOT_ENABLED, reason });
  if (!e.TEAMBOT_ENABLED) return off("TEAMBOT_ENABLED is not 1.");
  if (e.CHAIN_ID !== TEAMBOT_CHAIN_ID) return off(`The team bot runs on mainnet (${TEAMBOT_CHAIN_ID}) only; CHAIN_ID is ${e.CHAIN_ID}.`);
  if (!e.ALERT_BOT_TOKEN) return off("ALERT_BOT_TOKEN is not set (the team bot is the alert bot).");
  if (e.OPS_CHAT_ID === undefined) return off("OPS_CHAT_ID is not set (the staff group).");
  if (!e.TEAMBOT_DATA_DIR) return off("TEAMBOT_DATA_DIR is not set.");
  if (!path.isAbsolute(e.TEAMBOT_DATA_DIR)) return off("TEAMBOT_DATA_DIR must be a full path, starting with /.");
  const real = o.realpath ?? realOrResolved;
  const dataDir = real(e.TEAMBOT_DATA_DIR);
  if (isInside(dataDir, real(o.repoRoot ?? REPO_ROOT))) return off("TEAMBOT_DATA_DIR is inside the repo. It must be a private folder outside it.");
  if (e.TEAMBOT_TEST_CHAT_ID === undefined) return off("TEAMBOT_TEST_CHAT_ID is not set (Alert Test: release emergencies and test posts).");
  if (e.TEAMBOT_TEST_CHAT_ID === e.OPS_CHAT_ID) return off("TEAMBOT_TEST_CHAT_ID is the staff group. Use Alert Test.");
  if (e.TEAMBOT_RELEASE_HEARTBEAT !== undefined && !path.isAbsolute(e.TEAMBOT_RELEASE_HEARTBEAT)) return off("TEAMBOT_RELEASE_HEARTBEAT must be a full path, starting with /.");
  return {
    run: true,
    settings: {
      token: e.ALERT_BOT_TOKEN,
      chat: e.OPS_CHAT_ID,
      dataDir,
      testChat: e.TEAMBOT_TEST_CHAT_ID,
      releaseHeartbeat: e.TEAMBOT_RELEASE_HEARTBEAT,
    },
  };
}
