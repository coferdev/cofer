import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ContractFunctionRevertedError, encodeErrorResult, HttpRequestError } from "viem";
import { coferFactoryAbi } from "../src/chain/abi";
import { BETA_DEPOSIT_CAP_USDG, capRefusal, navReadFailureText, roomLeft, roomText, usdgText } from "../src/core/betaCap";

const U = 1_000_000n; // 1 USDG
const CAP = 5_000n * U;

describe("beta limit: the setting", () => {
  test("defaults to 5,000 USDG", () => {
    expect(BETA_DEPOSIT_CAP_USDG).toBe(CAP);
  });
});

describe("beta limit: room and refusals", () => {
  test("the example from the docs", () => {
    expect(roomText(3_750n * U, CAP)).toBe("This group can take up to 1,250 USDG more during the beta.");
  });

  test("an empty group can take the whole cap, and not one unit more", () => {
    expect(roomLeft(0n, CAP)).toBe(CAP);
    expect(capRefusal(CAP, 0n, CAP)).toBeNull();
    expect(capRefusal(CAP + 1n, 0n, CAP)).toBe("That's more than the beta limit allows. This group can take up to 5,000 USDG more during the beta.");
  });

  test("a deposit that lands exactly on the cap passes; one unit over is refused", () => {
    const nav = 3_750n * U;
    expect(capRefusal(1_250n * U, nav, CAP)).toBeNull();
    expect(capRefusal(1_250n * U + 1n, nav, CAP)).not.toBeNull();
  });

  test("a full group (or one above the cap after a price rise) takes nothing", () => {
    for (const nav of [CAP, CAP + 700n * U]) {
      expect(roomLeft(nav, CAP)).toBe(0n);
      expect(roomText(nav, CAP)).toBe("This group has reached the 5,000 USDG beta limit.");
      expect(capRefusal(1n, nav, CAP)).toBe("This group has reached the 5,000 USDG beta limit.");
    }
  });

  test("turned off (null): no line, nothing refused", () => {
    expect(roomLeft(10n ** 15n, null)).toBeNull();
    expect(roomText(10n ** 15n, null)).toBeNull();
    expect(capRefusal(10n ** 15n, 10n ** 15n, null)).toBeNull();
  });
});

describe("beta limit: amounts as text", () => {
  test("thousands separators, cents only when there are some, always rounded down", () => {
    expect(usdgText(0n)).toBe("0");
    expect(usdgText(5_000n * U)).toBe("5,000");
    expect(usdgText(1_234_567n * U)).toBe("1,234,567");
    expect(usdgText(1_250n * U + 500_000n)).toBe("1,250.50");
    expect(usdgText(1_250n * U + 999_999n)).toBe("1,250.99"); // never shows more room than there is
    expect(usdgText(7_000n)).toBe("0");
  });
});

describe("beta limit: an unreadable value is refused with fixed text", () => {
  test("a paused price feed and an RPC failure each get their own message, with no URL", () => {
    const data = encodeErrorResult({ abi: coferFactoryAbi, errorName: "StalePrice", args: ["0x322F0929c4625eD5bAd873c95208D54E1c003b2d"] });
    const stale = new ContractFunctionRevertedError({ abi: coferFactoryAbi, functionName: "navUsdg", data });
    expect(navReadFailureText(stale)).toContain("A price feed is paused");
    const rpc = new HttpRequestError({ url: "https://rpc.example/SECRETKEY123", details: "fetch failed" });
    expect(navReadFailureText(rpc)).toBe("Couldn't read the group's value just now. Nothing was sent. Try again in a minute.");
    for (const t of [navReadFailureText(stale), navReadFailureText(rpc)]) {
      expect(t).toContain("Nothing was sent");
      expect(t).not.toMatch(/https?:|SECRET/);
    }
  });
});

describe("beta limit: where it is used", () => {
  const client = readFileSync(join(import.meta.dir, "..", "src", "web", "client.ts"), "utf8");
  const section = (start: string, end: string) => client.slice(client.indexOf(start), client.indexOf(end));

  test("the deposit page checks the limit before the passkey is asked for", () => {
    const deposit = section('if (ex.purpose === "deposit")', 'else if (ex.purpose === "exit")');
    expect(deposit).toContain('functionName: "navUsdg"');
    const check = deposit.indexOf("capRefusal(amount, await readNav())");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(deposit.indexOf("await memberSigner()"));
    expect(check).toBeLessThan(deposit.indexOf("s.send!("));
  });

  test("exit, spend and card never read it", () => {
    const rest = client.slice(client.indexOf('else if (ex.purpose === "exit")'));
    for (const name of ["capRefusal", "readNav", "roomText", "navUsdg"]) expect(rest).not.toContain(name);
    const bot = readFileSync(join(import.meta.dir, "..", "src", "bot", "bot.ts"), "utf8");
    expect(bot.match(/roomLeft\(|roomText\(/g)?.length).toBe(3); // only in /deposit
    const depositCmd = bot.slice(bot.indexOf('bot.command("deposit"'), bot.indexOf('bot.command(["exit", "claim"]'));
    expect(depositCmd).toContain("roomText(nav)");
  });
});
