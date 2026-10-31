import { describe, expect, test } from "bun:test";
import { HttpRequestError, parseEther } from "viem";
import { ethText, relayerFundsProblem } from "../src/core/relayerFunds";
import { checkRelayerFunds, opsChecks, RELAYER_FUNDS_ALERT } from "../src/keeper/keeper";
import type { AlertDeps } from "../src/keeper/alerts";
import { parseEnv } from "../src/env";

const RELAYER = "0x00000000000000000000000000000000000Fee01";
const MIN = parseEther("0.005");

function fakeAlerts() {
  const open = new Map<string, string>();
  const sent: string[] = [];
  const alerts: AlertDeps = {
    async open(k, t) {
      if (open.has(k)) return false;
      open.set(k, t);
      return true;
    },
    async close(k) {
      const t = open.get(k) ?? null;
      open.delete(k);
      return t;
    },
    async send(t) {
      sent.push(t);
    },
  };
  return { alerts, open, sent };
}

describe("relayer ETH: the rule", () => {
  test("at or above the threshold: fine; below: the alert, with the public address to top up", () => {
    expect(relayerFundsProblem(RELAYER, MIN, MIN)).toBeNull();
    expect(relayerFundsProblem(RELAYER, parseEther("0.0031"), MIN)).toBe(
      `The relayer's ETH is low: 0.0031 ETH left (alert below 0.005 ETH). Send ETH on Robinhood Chain to ${RELAYER}. Until then, passed votes may not execute automatically. Members can still exit at any time.`,
    );
    expect(relayerFundsProblem(RELAYER, 0n, MIN)).toContain("0 ETH left");
  });

  test("ETH amounts: cut to 6 decimals, never rounded up", () => {
    expect(ethText(parseEther("1.25"))).toBe("1.25");
    expect(ethText(parseEther("0.0049999999"))).toBe("0.004999");
    expect(ethText(0n)).toBe("0");
  });

  test("the setting: 0.005 ETH by default, any decimal amount allowed", () => {
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
    expect(parseEnv(base).RELAYER_MIN_ETH).toBe(MIN);
    expect(parseEnv({ ...base, RELAYER_MIN_ETH: "0.02" }).RELAYER_MIN_ETH).toBe(parseEther("0.02"));
    expect(() => parseEnv({ ...base, RELAYER_MIN_ETH: "-1" })).toThrow();
    expect(() => parseEnv({ ...base, RELAYER_MIN_ETH: "lots" })).toThrow();
  });
});

describe("relayer ETH: the ops job", () => {
  test("alerts once while low, clears once topped up", async () => {
    const { alerts, sent } = fakeAlerts();
    let wei = parseEther("0.004");
    const deps = { address: () => RELAYER, balance: async () => wei, min: MIN, alerts };
    await checkRelayerFunds(deps);
    await checkRelayerFunds(deps);
    wei = parseEther("0.05");
    await checkRelayerFunds(deps);
    expect(sent.length).toBe(2);
    expect(sent[0]).toStartWith("The relayer's ETH is low: 0.004 ETH left");
    expect(sent[1]).toStartWith("Cleared: The relayer's ETH is low");
  });

  test("a failed balance read changes nothing and logs no URL", async () => {
    const { alerts, open, sent } = fakeAlerts();
    open.set(RELAYER_FUNDS_ALERT, "low");
    const logged: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void logged.push(a.join(" "));
    try {
      const r = await checkRelayerFunds({
        address: () => RELAYER,
        balance: async () => Promise.reject(new HttpRequestError({ url: "https://rpc.example/SECRETKEY123", details: "fetch failed" })),
        min: MIN,
        alerts,
      });
      expect(r).toBeNull();
    } finally {
      console.error = orig;
    }
    expect(open.has(RELAYER_FUNDS_ALERT)).toBe(true);
    expect(sent).toEqual([]);
    expect(logged.join(" ")).not.toContain("SECRETKEY123");
  });
});

describe("the ops job runs every check", () => {
  test("a failing check does not stop the next one, and the job still fails afterwards", async () => {
    const ran: string[] = [];
    const boom = new Error("db down");
    const job = opsChecks({
      first: async () => {
        ran.push("first");
        throw boom;
      },
      second: async () => {
        ran.push("second");
        return 1;
      },
    });
    await expect(job).rejects.toBe(boom);
    expect(ran).toEqual(["first", "second"]);
  });

  test("all fine: every result is returned", async () => {
    expect(await opsChecks({ a: async () => 1, b: async () => "x" })).toEqual({ a: 1, b: "x" });
  });
});
