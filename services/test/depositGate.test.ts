import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Address } from "viem";
import { DEPOSITS_CLOSED_TEXT, readDepositGate, stalestForDeposit } from "../src/core/depositGate";

const USDG = "0x00000000000000000000000000000000000005d6" as Address;
const TSLA = "0x0000000000000000000000000000000000000075" as Address;
const SPY = "0x0000000000000000000000000000000000000057" as Address;
const POT = "0x00000000000000000000000000000000000000aa" as Address;
const FACTORY = "0x00000000000000000000000000000000000000fa" as Address;
const H = 3600;
const NOW = 1_800_000_000;

describe("deposit price-age gate (audit M-1), same rule as CoferPot", () => {
  test("a held stock with a price older than 12h closes deposits; exactly 12h is still open", () => {
    expect(stalestForDeposit([{ asset: TSLA, distributable: 1n, updatedAt: NOW - 12 * H }], NOW, 12 * H)).toBeNull();
    expect(stalestForDeposit([{ asset: TSLA, distributable: 1n, updatedAt: NOW - 12 * H - 1 }], NOW, 12 * H)).toEqual({ asset: TSLA, ageSec: 12 * H + 1 });
  });

  test("an asset the pot no longer holds any of is ignored, as in the contract", () => {
    expect(stalestForDeposit([{ asset: SPY, distributable: 0n, updatedAt: NOW - 3 * 24 * H }], NOW, 12 * H)).toBeNull();
  });

  test("the reader skips USDG, uses the contract's own limit and the chain's time", async () => {
    const reads: string[] = [];
    const client = {
      getBlock: async () => ({ timestamp: BigInt(NOW) }),
      readContract: async (a: { address: Address; functionName: string; args?: readonly unknown[] }) => {
        reads.push(`${a.functionName}${a.args ? `(${String(a.args[0])})` : ""}`);
        switch (a.functionName) {
          case "heldAssets":
            return [USDG, TSLA];
          case "MAX_DEPOSIT_PRICE_AGE":
            return 12 * H;
          case "distributable":
            return 5n;
          case "priceUpdatedAt":
            return BigInt(NOW - 13 * H);
        }
        throw new Error(a.functionName);
      },
    };
    expect(await readDepositGate(client as never, POT, FACTORY)).toEqual({ asset: TSLA, ageSec: 13 * H });
    expect(reads).not.toContain(`priceUpdatedAt(${USDG})`);
  });

  test("the text says why and that exits stay open", () => {
    expect(DEPOSITS_CLOSED_TEXT).toBe("Deposits are closed until the stock price updates (markets closed). Exiting is always open.");
  });

  test("the bot and the signer page check before any link or passkey", () => {
    const bot = readFileSync(join(import.meta.dir, "..", "src", "bot", "bot.ts"), "utf8");
    const cmd = bot.slice(bot.indexOf('bot.command("deposit"'), bot.indexOf('bot.command("claim"'));
    expect(cmd.indexOf("readDepositGate(")).toBeGreaterThan(0);
    expect(cmd.indexOf("readDepositGate(")).toBeLessThan(cmd.indexOf('signerUrl(linkCtx(ctx), "deposit"'));
    const page = readFileSync(join(import.meta.dir, "..", "src", "web", "client.ts"), "utf8");
    const dep = page.slice(page.indexOf('ex.purpose === "deposit"'), page.indexOf('ex.purpose === "exit"'));
    expect(dep.indexOf("readDepositGate(")).toBeGreaterThan(0);
    expect(dep.indexOf("readDepositGate(")).toBeLessThan(dep.indexOf("await memberSigner()"));
    expect(dep).toContain("throw new Stop(DEPOSITS_CLOSED_TEXT,");
  });

  test("the services' 12h matches the contract constant", () => {
    const pot = readFileSync(join(import.meta.dir, "..", "..", "contracts", "src", "CoferPot.sol"), "utf8");
    expect(pot).toContain("uint32 public constant MAX_DEPOSIT_PRICE_AGE = 12 hours;");
  });
});
