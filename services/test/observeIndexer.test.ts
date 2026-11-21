import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { compareWithApi } from "../scripts/ops/compare";
import { parseEnv } from "../src/env";
import type { EventIn } from "../src/indexer/projections/runner";

const POT = "0x362B6794E6374b400aA186C1a67AC2c060af2E50";
const A = "0x215Ea29bE890960586CEc7e35B381F6599f955aa";
let li = 0;
const ev = (block: number, name: string, args: Record<string, string>): EventIn => ({ block: BigInt(block), logIndex: li++, txHash: `0x${block.toString(16).padStart(64, "0")}`, address: POT, name, args });
const MINE = [ev(1, "MemberAdded", { member: A }), ev(2, "Deposited", { member: A, amount: "100", shares: "100", navBefore: "0" })];

describe("run your own indexer", () => {
  test("your index and the API agree", () => {
    expect(compareWithApi(POT, MINE, { members: [{ address: A, active: true, shares: "100" }], timeline: [{ block: "1", logIndex: 0, txHash: MINE[0]!.txHash, event: "MemberAdded" }, { block: "2", logIndex: 1, txHash: MINE[1]!.txHash, event: "Deposited" }] })).toEqual([]);
  });

  test("a different share count or an event your index lacks is named", () => {
    const d = compareWithApi(POT, MINE, { members: [{ address: A, active: true, shares: "90" }], timeline: [{ block: "3", logIndex: 9, txHash: "0x", event: "Exited" }] });
    expect(d).toEqual([`member ${A}: your index 100 shares (active), the API 90 (active)`, "event Exited at block 3 (log 9): in the API, not in your index"]);
  });

  test("observe-only mode is a setting, off unless set to 1", () => {
    const base = { PUBLIC_URL: "https://s.example", DATABASE_URL: "x", RHC_RPC_URL: "https://r.example", FACTORY_ADDRESS: "0x0000000000000000000000000000000000000001", ADAPTER_ADDRESS: "0x0000000000000000000000000000000000000002", RELAYER_PRIVATE_KEY: "0x01", TELEGRAM_BOT_TOKEN: "1:x", TELEGRAM_BOT_USERNAME: "x", TELEGRAM_WEBHOOK_SECRET: "w".repeat(24), LINK_SECRET: "l".repeat(32) };
    expect(parseEnv(base).INDEXER_OBSERVE_ONLY).toBe(false);
    expect(parseEnv({ ...base, INDEXER_OBSERVE_ONLY: "1", ROLE: "indexer" }).INDEXER_OBSERVE_ONLY).toBe(true);
  });

  test("observe-only needs no Telegram, signer or key settings, and runs only as the indexer", () => {
    const min = { DATABASE_URL: "x", RHC_RPC_URL: "https://r.example", FACTORY_ADDRESS: "0x0000000000000000000000000000000000000001", ADAPTER_ADDRESS: "0x0000000000000000000000000000000000000002", INDEXER_OBSERVE_ONLY: "1" };
    const e = parseEnv({ ...min, ROLE: "indexer" });
    expect(e.RELAYER_PRIVATE_KEY).toBe("0x0");
    expect(e.PUBLIC_URL).toContain(".invalid");
    expect(() => parseEnv({ ...min, ROLE: "all" })).toThrow("only with ROLE=indexer");
    expect(() => parseEnv(min)).toThrow("only with ROLE=indexer");
  });

  test("observe-only mode only records: no projection, alert, message or Telegram table is written", () => {
    const src = readFileSync(new URL("../src/indexer/observe.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/schema\.(members|pots|proposals|signatures|users)\b.*insert|enqueue|postAlert|checkAlert|chatId/);
    expect(src).toContain("await record(log, ev.eventName, ev.args);");
  });
});

describe("guide: run your own indexer", () => {
  const guide = readFileSync(new URL("../../docs/ops/run-your-own-indexer.md", import.meta.url), "utf8");
  test("its settings parse, with observe-only on and testnet's chain", () => {
    const block = /```bash\nCHAIN_ID=[\s\S]*?```/.exec(guide)![0];
    const env: Record<string, string> = {};
    for (const l of block.split("\n")) {
      const m = /^([A-Z_]+)=(.*)$/.exec(l);
      if (m) env[m[1]!] = m[2]!;
    }
    const e = parseEnv(env);
    expect(e.INDEXER_OBSERVE_ONLY).toBe(true);
    expect(e.CHAIN_ID).toBe(46630);
    expect(e.ROLE).toBe("indexer");
  });

  test("the commands it names exist", () => {
    expect(guide).toContain("bun scripts/ops/compare.ts --pot 0x… --api https://<signer site>");
    expect(readFileSync(new URL("../scripts/ops/compare.ts", import.meta.url), "utf8")).toContain("export function compareWithApi");
  });
});
