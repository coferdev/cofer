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
import { UserError } from "../src/core/errors";
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

  test("no source or script file uses web_app / webApp / setChatMenuButton (only the two guards name them)", () => {
    const hits: string[] = [];
    // the guards have to name what they refuse
    const guards = [join("src", "bot", "keyboards.ts"), join("src", "bot", "noMiniApp.ts")];
    const root = new URL("..", import.meta.url).pathname;
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts") && !guards.some((g) => p.endsWith(g))) {
          const s = readFileSync(p, "utf8");
          if (/\.webApp\(|["']?web_app["']?\s*:|setChatMenuButton|MenuButtonWebApp|answerWebAppQuery|savePreparedInlineMessage|login_url/.test(s)) hits.push(p);
        }
      }
    };
    walk(join(root, "src"));
    walk(join(root, "scripts"));
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
    expect(parseSell("/sell NVDA 25%")).toEqual({ symbol: "NVDA", pctBps: 2500, slipBps: 100 });
    expect(parseSell("/sell NVDA all").pctBps).toBe(10_000);
    expect(parseAllowance("/allowance @amy 50 week")).toEqual({ who: "@amy", usdg: 50_000_000n, period: 604800 });
    expect(parseAllowance("/allowance @amy off")).toEqual({ who: "@amy", usdg: 0n, period: 0 });
    expect(parseSend("/send 12 @bob")).toEqual({ usdg: 12_000_000n, to: "@bob" });
  });

  test("slip= works on /sell exactly like /buy", () => {
    expect(parseSell("/sell TSLA 50% slip=0.5")).toEqual({ symbol: "TSLA", pctBps: 5000, slipBps: 50 });
    expect(parseSell("/sell TSLA 50% slip=0.5%").slipBps).toBe(50);
    expect(parseSell("/sell tsla slip=2 50%")).toEqual({ symbol: "TSLA", pctBps: 5000, slipBps: 200 }); // any order
    expect(parseSell("/sell TSLA slip=0.5")).toEqual({ symbol: "TSLA", pctBps: 10_000, slipBps: 50 }); // no amount = all
    expect(parseSell("/sell TSLA all").slipBps).toBe(100); // default 1%, same as /buy
    expect(parseBuy("/buy TSLA 100").slipBps).toBe(100);
    for (const bad of ["slip=0", "slip=10.01", "slip=abc"]) {
      expect(() => parseSell(`/sell TSLA 50% ${bad}`)).toThrow(UserError);
      expect(() => parseBuy(`/buy TSLA 100 ${bad}`)).toThrow(UserError);
    }
    expect(parseSell("/sell TSLA 50% slip=10").slipBps).toBe(1000);
    expect(parseSell("/sell TSLA 50% slip=0.01").slipBps).toBe(1);
    expect(() => parseSell("/sell slip=1")).toThrow(UserError);
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

  // Unmodified response from GET https://api.robinhood.com/rhj/assets, saved 2026-10-30.
  const saved = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "stock-assets-4663.json"), "utf8"));

  test("saved issuer response: every asset parses, with its chain 4663 address", () => {
    const list = parseAssets(saved);
    expect(list.length).toBe(203);
    expect(new Set(list.map((s) => s.symbol)).size).toBe(203);
    const bySymbol = new Map(list.map((s) => [s.symbol, s]));
    expect(bySymbol.get("TSLA")?.address).toBe("0x322F0929c4625eD5bAd873c95208D54E1c003b2d");
    expect(bySymbol.get("AAPL")?.address).toBe("0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9");
    expect(bySymbol.get("NVDA")?.address).toBe("0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC");
    expect(bySymbol.get("SPY")?.address).toBe("0x117cc2133c37B721F49dE2A7a74833232B3B4C0C");
    const tsla = bySymbol.get("TSLA")!;
    expect(tsla.decimals).toBe(18);
    expect(tsla.currentMultiplier).toBe("1.000000000000000000");
    expect(tsla.pendingMultiplier).toBeNull(); // "" in the response means nothing pending
    expect(tsla.tradable).toBe(true);
    expect(parseAssets(saved, 1)).toEqual([]); // no other chain leaks in
  });

  test("older field names still parse", () => {
    const dep = [{ chainId: "4663", contractAddress: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C" }];
    expect(parseAssets([{ ticker: "SPY", status: "active", deployments: dep }]).map((s) => s.symbol)).toEqual(["SPY"]);
    expect(parseAssets({ data: [{ symbol: "SPY", status: "active", deployments: dep }] }).map((s) => s.symbol)).toEqual(["SPY"]);
  });

  test("fails closed on anything unexpected", () => {
    const addr = "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C";
    for (const json of [null, undefined, {}, "x", { assets: "x" }, { assets: [{}] }]) expect(parseAssets(json)).toEqual([]);
    expect(parseAssets({ assets: [{ deployments: [{ chainId: 4663, contractAddress: addr }] }] })).toEqual([]); // no symbol
    expect(parseAssets({ assets: [{ tokenSymbol: "SPY" }] })).toEqual([]); // no deployment
    expect(parseAssets({ assets: [{ tokenSymbol: "SPY", deployments: [{ chainId: 4663, contractAddress: "0x123" }] }] })).toEqual([]);
    const withStatus = (status?: string) =>
      parseAssets({ assets: [{ tokenSymbol: "SPY", status, deployments: [{ chainId: 4663, contractAddress: addr }] }] })[0]!.tradable;
    expect(withStatus("ASSET_STATUS_ACTIVE")).toBe(true);
    expect(withStatus("ASSET_STATUS_INACTIVE")).toBe(false);
    expect(withStatus("UNTRADABLE")).toBe(false);
    expect(withStatus("DISABLED")).toBe(false);
    expect(withStatus(undefined)).toBe(false);
    expect(isCanonical(parseAssets(saved), "0x0000000000000000000000000000000000000001")).toBe(false);
  });
});

describe("chat card + card adapter", () => {
  test("card text tells dissenters they can exit", () => {
    const t = renderCard({ summary: "Send 100 USDG to @bob", status: "queued", approvals: 3, required: 3, delaySeconds: 21600, queuedEta: 1_900_000_000 });
    expect(t).toContain("/exit");
  });

  test("stub card adapter quotes with a load fee and issues after funding", async () => {
    const c = new StubCardAdapter("0x00000000000000000000000000000000000000f1");
    expect(await c.quote({ pot: "0x0000000000000000000000000000000000000001", member: "0x0000000000000000000000000000000000000002", amountUsdg: 5_000_000n })).toBeNull();
    const q = (await c.quote({ pot: "0x0000000000000000000000000000000000000001", member: "0x0000000000000000000000000000000000000002", amountUsdg: 100_000_000n }))!;
    expect(q.amountUsdg).toBe(101_500_000n);
    expect((await c.confirm({ orderId: q.orderId, spendTx: "0x01" })).status).toBe("issued");
  });
});
