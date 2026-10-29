import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { InlineKeyboard } from "grammy";
import { groupCanBuyStocks, regionAllowsStocks } from "../src/core/geo";
import { signLink, verifyLink } from "../src/core/linkToken";
import { loginHash, verifyTelegramLogin } from "../src/core/telegramLogin";
import { assertNoMiniApp, linkButton, proposalCard, signerUrl } from "../src/bot/keyboards";
import { parseAllowance, parseBuy, parsePeriod, parseSell, parseSend, parseUsdg } from "../src/bot/parse";
import { isCanonical, multiplierToWad, parseAssets } from "../src/stocks/canonical";
import { renderCard } from "../src/notifier/notifier";
import { StubCardAdapter } from "../src/cards/StubCardAdapter";

describe("geo gating for Stock Token buys", () => {
  test("excluded regions and undeclared members block the whole group", () => {
    expect(regionAllowsStocks({ declared: "FR" })).toBe(true);
    for (const c of ["US", "GB", "CA", "CH", "AE"]) expect(regionAllowsStocks({ declared: c })).toBe(false);
    expect(regionAllowsStocks({ declared: "FR", ipCountry: "US" })).toBe(false);
    expect(groupCanBuyStocks([{ declared: "FR" }, { declared: "DE" }]).allowed).toBe(true);
    expect(groupCanBuyStocks([{ declared: "FR" }, { declared: null }])).toEqual({ allowed: false, blockedMembers: 0, undeclaredMembers: 1 });
    expect(groupCanBuyStocks([{ declared: "FR" }, { declared: "CA" }]).blockedMembers).toBe(1);
  });
});

describe("signer links and Telegram login", () => {
  const secret = "x".repeat(40);
  test("links verify, expire and reject tampering", () => {
    const now = 1_000;
    const t = signLink({ tg: 7, chat: -100, p: "sign", ref: "0xabc", exp: now + 60, jti: "j" }, secret);
    expect(verifyLink(t, secret, now).tg).toBe(7);
    expect(() => verifyLink(t, secret, now + 61)).toThrow("expired");
    expect(() => verifyLink(t, "y".repeat(40), now)).toThrow();
    const [body, mac] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ tg: 8, chat: -100, p: "sign", ref: "0xabc", exp: now + 60, jti: "j" })).toString("base64url");
    expect(() => verifyLink(`${forged}.${mac}`, secret, now)).toThrow();
    expect(body).toBeTruthy();
  });

  test("Telegram Login Widget hash", () => {
    const fields = { id: 42, first_name: "Ann", auth_date: 1_000, username: "ann" };
    const hash = loginHash(fields, "123:abc");
    expect(verifyTelegramLogin({ ...fields, hash }, "123:abc", 86_400, 1_500)).toBe(true);
    expect(verifyTelegramLogin({ ...fields, id: 43, hash }, "123:abc", 86_400, 1_500)).toBe(false);
    expect(verifyTelegramLogin({ ...fields, hash }, "123:abc", 86_400, 1_000 + 90_000)).toBe(false);
  });
});

describe("Telegram compliance: plain bot, never a Mini App", () => {
  test("our keyboards only use url/callback buttons", () => {
    const url = signerUrl({ publicUrl: "https://sign.example", secret: "s".repeat(40), tgId: 1, chatId: 2 }, "sign", "0x1");
    expect(url.startsWith("https://sign.example/s/")).toBe(true);
    assertNoMiniApp(proposalCard("0x" + "1".repeat(64)));
    assertNoMiniApp(linkButton("Go", url));
  });

  test("a web_app button is rejected", () => {
    const kb = new InlineKeyboard().webApp("x", "https://example.com");
    expect(() => assertNoMiniApp(kb)).toThrow();
  });

  test("no source file uses web_app / webApp / setChatMenuButton", () => {
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts") && !p.includes("keyboards.ts")) {
          const s = readFileSync(p, "utf8");
          if (/\.webApp\(|web_app\s*:|setChatMenuButton|MenuButtonWebApp/.test(s)) hits.push(p);
        }
      }
    };
    walk(new URL("../src", import.meta.url).pathname);
    expect(hits).toEqual([]);
  });
});

describe("command parsing", () => {
  test("amounts and periods", () => {
    expect(parseUsdg("50")).toBe(50_000_000n);
    expect(parseUsdg("$1,250.5")).toBe(1_250_500_000n);
    expect(() => parseUsdg("1.0000001")).toThrow();
    expect(parsePeriod("week")).toBe(604800);
    expect(parsePeriod("3d")).toBe(259200);
    expect(() => parsePeriod("fortnight")).toThrow();
  });

  test("buy / sell / allowance / send", () => {
    expect(parseBuy("/buy tsla 100 slip=0.5%")).toEqual({ symbol: "TSLA", usdg: 100_000_000n, slipBps: 50 });
    expect(parseSell("/sell NVDA 25%")).toEqual({ symbol: "NVDA", pctBps: 2500 });
    expect(parseSell("/sell NVDA all").pctBps).toBe(10_000);
    expect(parseAllowance("/allowance @amy 50 week")).toEqual({ who: "@amy", usdg: 50_000_000n, period: 604800 });
    expect(parseAllowance("/allowance @amy off")).toEqual({ who: "@amy", usdg: 0n, period: 0 });
    expect(parseSend("/send 12 @bob")).toEqual({ usdg: 12_000_000n, to: "@bob" });
  });
});

describe("canonical Stock Token list", () => {
  test("tolerant parsing, chain filter, fail closed", () => {
    const json = {
      results: [
        { symbol: "SPY", tokenDecimals: 18, currentMultiplier: "1.0", deployments: [{ chainId: 4663, contractAddress: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C" }] },
        { symbol: "XYZ", deployments: [{ chainId: 1, contractAddress: "0x0000000000000000000000000000000000000001" }] },
        { symbol: "BAD", deployments: [{ chainId: 4663, contractAddress: "nope" }] },
      ],
    };
    const list = parseAssets(json);
    expect(list.map((s) => s.symbol)).toEqual(["SPY"]);
    expect(isCanonical(list, "0x117cc2133c37b721f49de2a7a74833232b3b4c0c")).toBe(true);
    expect(isCanonical(list, "0x0000000000000000000000000000000000000001")).toBe(false);
    expect(multiplierToWad("1.5")).toBe(1_500_000_000_000_000_000n);
  });
});

describe("chat card + card adapter", () => {
  test("card text tells dissenters they can exit", () => {
    const t = renderCard({ summary: "Send 100 USDG to @bob", status: "queued", approvals: 3, required: 3, delaySeconds: 21600, queuedEta: 1_900_000_000 });
    expect(t).toContain("/exit");
  });

  test("stub card adapter quotes with a load fee and issues after funding", async () => {
    const c = new StubCardAdapter();
    expect(await c.quote({ pot: "0x0000000000000000000000000000000000000001", member: "0x0000000000000000000000000000000000000002", amountUsdg: 5_000_000n })).toBeNull();
    const q = (await c.quote({ pot: "0x0000000000000000000000000000000000000001", member: "0x0000000000000000000000000000000000000002", amountUsdg: 100_000_000n }))!;
    expect(q.amountUsdg).toBe(101_500_000n);
    expect((await c.confirm({ orderId: q.orderId, spendTx: "0x01" })).status).toBe("issued");
  });
});
