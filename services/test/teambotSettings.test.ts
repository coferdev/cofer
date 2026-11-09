import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnv } from "../src/env";
import { isInside, REPO_ROOT, teambotDecision } from "../src/teambot/settings";

const TOKEN = "7000000001:AAFakeAlertBotTokenSECRETxyz";
const base = {
  PUBLIC_URL: "https://sign.example",
  DATABASE_URL: "postgres://x",
  RHC_RPC_URL: "https://rpc.example",
  FACTORY_ADDRESS: `0x${"1".repeat(40)}`,
  ADAPTER_ADDRESS: `0x${"2".repeat(40)}`,
  RELAYER_PRIVATE_KEY: "0x01",
  TELEGRAM_BOT_TOKEN: "t",
  TELEGRAM_BOT_USERNAME: "b",
  TELEGRAM_WEBHOOK_SECRET: "s".repeat(16),
  LINK_SECRET: "l".repeat(32),
};
const OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), "teambot-data-"));
const mainnet = {
  ...base,
  CHAIN_ID: "4663",
  TEAMBOT_ENABLED: "1",
  ALERT_BOT_TOKEN: TOKEN,
  OPS_CHAT_ID: "-1001234567890",
  TEAMBOT_DATA_DIR: OUTSIDE,
  TEAMBOT_GITHUB_TOKEN: "github_pat_FAKE",
};
const decide = (src: Record<string, string | undefined>) => teambotDecision(parseEnv(src));
const reason = (src: Record<string, string | undefined>) => {
  const d = decide(src);
  return d.run ? null : d.reason;
};

describe("team bot settings", () => {
  test("all optional; off by default, and the GitHub mode defaults to publish", () => {
    const e = parseEnv(base);
    expect(e.TEAMBOT_ENABLED).toBe(false);
    expect(e.TEAMBOT_DATA_DIR).toBeUndefined();
    expect(e.TEAMBOT_GITHUB_TOKEN).toBeUndefined();
    expect(e.TEAMBOT_GITHUB_MODE).toBe("publish");
    expect(e.TEAMBOT_TEST_CHAT_ID).toBeUndefined();
    expect(decide(base)).toEqual({ run: false, enabled: false, reason: "TEAMBOT_ENABLED is not 1." });
  });

  test("only 0 or 1 are accepted for TEAMBOT_ENABLED; bad values stop start-up like any other bad setting", () => {
    expect(parseEnv({ ...base, TEAMBOT_ENABLED: "0" }).TEAMBOT_ENABLED).toBe(false);
    expect(() => parseEnv({ ...base, TEAMBOT_ENABLED: "yes" })).toThrow();
    expect(() => parseEnv({ ...base, TEAMBOT_GITHUB_MODE: "push" })).toThrow();
    expect(() => parseEnv({ ...base, TEAMBOT_TEST_CHAT_ID: "group" })).toThrow();
  });

  test("everything set on mainnet: it runs, with the alert bot and the staff group", () => {
    const d = decide(mainnet);
    expect(d.run).toBe(true);
    if (!d.run) return;
    expect(d.settings).toEqual({ token: TOKEN, chat: -1001234567890, dataDir: fs.realpathSync(OUTSIDE), githubToken: "github_pat_FAKE", githubMode: "publish", testChat: undefined });
  });

  test("testnet never runs it, even with TEAMBOT_ENABLED=1", () => {
    expect(reason({ ...mainnet, CHAIN_ID: "46630" })).toBe("The team bot runs on mainnet (4663) only; CHAIN_ID is 46630.");
  });

  test("needs the alert bot and the staff group", () => {
    expect(reason({ ...mainnet, ALERT_BOT_TOKEN: undefined })).toBe("ALERT_BOT_TOKEN is not set (the team bot is the alert bot).");
    expect(reason({ ...mainnet, OPS_CHAT_ID: undefined })).toBe("OPS_CHAT_ID is not set (the staff group).");
  });

  test("the data folder must be a full path outside the repo", () => {
    expect(reason({ ...mainnet, TEAMBOT_DATA_DIR: undefined })).toBe("TEAMBOT_DATA_DIR is not set.");
    expect(reason({ ...mainnet, TEAMBOT_DATA_DIR: "teambot-data" })).toBe("TEAMBOT_DATA_DIR must be a full path, starting with /.");
    const inRepo = "TEAMBOT_DATA_DIR is inside the repo. It must be a private folder outside it.";
    expect(reason({ ...mainnet, TEAMBOT_DATA_DIR: REPO_ROOT })).toBe(inRepo);
    expect(reason({ ...mainnet, TEAMBOT_DATA_DIR: path.join(REPO_ROOT, "services", "data") })).toBe(inRepo);
    expect(reason({ ...mainnet, TEAMBOT_DATA_DIR: path.join(REPO_ROOT, "services", "..", "posters") })).toBe(inRepo);
  });

  test("a link outside the repo that points back inside it is refused", () => {
    const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "teambot-link-")), "data");
    fs.symlinkSync(path.join(REPO_ROOT, "docs"), link);
    expect(reason({ ...mainnet, TEAMBOT_DATA_DIR: link })).toBe("TEAMBOT_DATA_DIR is inside the repo. It must be a private folder outside it.");
  });

  test("the test group can never be the staff group", () => {
    expect(reason({ ...mainnet, TEAMBOT_TEST_CHAT_ID: "-1001234567890" })).toBe("TEAMBOT_TEST_CHAT_ID is the staff group. Use a separate test group.");
    const d = decide({ ...mainnet, TEAMBOT_TEST_CHAT_ID: "-1009999" });
    expect(d.run && d.settings.testChat).toBe(-1009999);
  });

  test("publishing drafts needs a GitHub token; check and off do not", () => {
    expect(reason({ ...mainnet, TEAMBOT_GITHUB_TOKEN: undefined })).toBe("TEAMBOT_GITHUB_MODE is publish but TEAMBOT_GITHUB_TOKEN is not set.");
    expect(decide({ ...mainnet, TEAMBOT_GITHUB_TOKEN: undefined, TEAMBOT_GITHUB_MODE: "check" }).run).toBe(true);
    expect(decide({ ...mainnet, TEAMBOT_GITHUB_TOKEN: undefined, TEAMBOT_GITHUB_MODE: "off" }).run).toBe(true);
  });

  test("a reason never holds a secret", () => {
    for (const src of [{ ...mainnet, CHAIN_ID: "46630" }, { ...mainnet, TEAMBOT_DATA_DIR: REPO_ROOT }, { ...mainnet, TEAMBOT_TEST_CHAT_ID: "-1001234567890" }]) {
      const r = reason(src) ?? "";
      expect(r).not.toContain("SECRET");
      expect(r).not.toContain("github_pat");
    }
  });

  test("inside or not", () => {
    expect(isInside("/a/b", "/a")).toBe(true);
    expect(isInside("/a", "/a")).toBe(true);
    expect(isInside("/ab", "/a")).toBe(false);
    expect(isInside("/x/a", "/a")).toBe(false);
  });
});
