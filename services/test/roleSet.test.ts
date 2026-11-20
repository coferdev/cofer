import { describe, expect, test } from "bun:test";
import type { Address, Hex } from "viem";
import { addressBook } from "../src/core/alertFormat";
import { ROLES_ALERT, roleProblem, SINKS_ALERT_KEY, sinksProblem, type RoleState } from "../src/core/roles";
import { parseEnv } from "../src/env";
import { adminDecision, SINKS_ALERT } from "../src/indexer/adminEvents";
import type { AlertDeps } from "../src/keeper/alerts";
import { checkRoles } from "../src/keeper/keeper";

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const TX = `0x${"11".repeat(32)}` as Hex;
const SAFE = A(0x5afe);
const GUARD = A(0x9a);
const WORK = A(0x3f34);
const S1 = A(0xf731);
const S2 = A(0x8dec);
const S3 = A(0x3776);
const SINKS = [WORK, SAFE, SAFE, SAFE];
const good: RoleState = { factoryOwner: SAFE, factoryPendingOwner: A(0), guardian: GUARD, routerOwner: SAFE, routerPendingOwner: A(0), safeSigners: [S1, S2, S3], sinks: SINKS };
const base = { PUBLIC_URL: "https://sign.example", DATABASE_URL: "postgres://x", RHC_RPC_URL: "https://rpc.example", FACTORY_ADDRESS: SAFE, ADAPTER_ADDRESS: SAFE, RELAYER_PRIVATE_KEY: "0x01", TELEGRAM_BOT_TOKEN: "t", TELEGRAM_BOT_USERNAME: "b", TELEGRAM_WEBHOOK_SECRET: "s".repeat(16), LINK_SECRET: "s".repeat(32) };

function fakeAlerts() {
  const open = new Map<string, string>();
  const sent: string[] = [];
  const alerts: AlertDeps = {
    open: async (k, t) => (open.has(k) ? false : (open.set(k, t), true)),
    close: async (k) => {
      const t = open.get(k) ?? null;
      open.delete(k);
      return t;
    },
    send: async (t) => void sent.push(t),
  };
  return { open, sent, alerts };
}

describe("expected fee sinks and Safe signers", () => {
  test("settings: four sinks in order, signers as a list, both optional, bad values refused", () => {
    const e = parseEnv({ ...base, EXPECTED_FEE_SINKS: SINKS.join(","), EXPECTED_SAFE_SIGNERS: ` ${S1}, ${S2},${S3} ` });
    expect(e.EXPECTED_FEE_SINKS).toHaveLength(4);
    expect(e.EXPECTED_SAFE_SIGNERS).toHaveLength(3);
    expect(parseEnv(base).EXPECTED_FEE_SINKS).toBeUndefined();
    expect(() => parseEnv({ ...base, EXPECTED_FEE_SINKS: [WORK, SAFE, SAFE].join(",") })).toThrow();
    expect(() => parseEnv({ ...base, EXPECTED_SAFE_SIGNERS: `${S1},0x12` })).toThrow();
  });

  test("signers: same set in any order is fine; an added or missing signer is named", () => {
    expect(roleProblem(good, { owner: SAFE, guardian: GUARD, signers: [S3, S1, S2] })).toBeNull();
    const p = roleProblem({ ...good, safeSigners: [S1, S2, A(0xbad)] }, { signers: [S1, S2, S3] })!;
    expect(p).toContain(`unexpected signer ${A(0xbad)}`);
    expect(p).toContain(`no longer has signer ${S3}`);
    expect(roleProblem({ ...good, safeSigners: undefined }, { signers: [S1] })).toBeNull(); // not read: not judged
  });

  test("sinks: compared in order, each wrong one named", () => {
    expect(sinksProblem(SINKS, SINKS.map((a) => a.toUpperCase().replace("0X", "0x")))).toBeNull();
    const p = sinksProblem([SAFE, SAFE, SAFE, A(0xdead)], SINKS)!;
    expect(p).toContain(`work sink is ${SAFE}, expected ${WORK}`);
    expect(p).toContain(`burn sink is ${A(0xdead)}`);
    expect(p).not.toContain("treasury");
  });

  test("the indexer judges a SinksSet against the expected sinks when they are set", () => {
    const x = { owner: SAFE, guardian: GUARD, feeWallet: WORK, feeSinks: SINKS, adapter: A(0xad), factory: A(0xf0) };
    const ev = (sinks: Address[]) => ({ source: "feeRouter" as const, name: "SinksSet", args: { sinks, bps: [8000, 1000, 500, 500] }, txHash: TX });
    const ok = adminDecision(ev(SINKS), x)!;
    expect(ok.level).toBe("info");
    expect(ok.clears?.key).toBe(SINKS_ALERT);
    const bad = adminDecision(ev([WORK, SAFE, SAFE, WORK]), x)!;
    expect(bad).toMatchObject({ level: "emergency", key: SINKS_ALERT });
    expect(bad.what).toContain("not the expected fee sinks");
    // without feeSinks the old one-wallet rule still applies
    expect(adminDecision(ev(SINKS), { ...x, feeSinks: undefined })!.level).toBe("emergency");
    expect(SINKS_ALERT).toBe(SINKS_ALERT_KEY);
  });

  test("the keeper: today's setup clears both alerts; any later change to a signer, the guardian or a sink alerts again", async () => {
    const { open, alerts } = fakeAlerts();
    open.set(ROLES_ALERT, "guardian changed");
    open.set(SINKS_ALERT_KEY, "sinks changed");
    let state: RoleState = good;
    const deps = { read: async () => state, expected: { owner: SAFE, guardian: GUARD, signers: [S1, S2, S3], feeSinks: SINKS }, alerts };
    expect(await checkRoles(deps)).toBe(true);
    expect(open.size).toBe(0);
    state = { ...good, safeSigners: [S1, S2, A(0xbad)] };
    expect(await checkRoles(deps)).toBe(false);
    expect(open.has(ROLES_ALERT)).toBe(true);
    state = { ...good, sinks: [WORK, SAFE, SAFE, A(0xbad)] };
    expect(await checkRoles(deps)).toBe(false);
    expect(open.has(SINKS_ALERT_KEY)).toBe(true);
    expect(open.has(ROLES_ALERT)).toBe(false);
    state = { ...good, guardian: A(0xbad) };
    expect(await checkRoles(deps)).toBe(false);
    expect(open.has(ROLES_ALERT)).toBe(true);
    expect(open.has(SINKS_ALERT_KEY)).toBe(false);
  });

  test("names: the work sink is the work fee wallet, and no one is the fee wallet any more", () => {
    const book = addressBook({ owner: SAFE, guardian: GUARD, workWallet: WORK });
    expect(book.get(WORK.toLowerCase())).toBe("work fee wallet");
    expect(book.get(GUARD.toLowerCase())).toBe("guardian");
    expect([...book.values()]).not.toContain("fee wallet");
  });
});
