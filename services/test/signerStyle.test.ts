/**
 * The signer pages look like the website (Geist, monochrome, black panel on grey), with fonts served
 * from this server, and the wallet window shows every wallet it can. Look and settings only: the
 * passkey page's security policy and behavior are unchanged (csp.test.ts, walletOption.test.ts).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PAGE_CSS, SIGNER_CSP, WALLET_CSP, signerPage } from "../src/web/page";
import { createServer, SIGNER_FONTS } from "../src/api/server";
import { parseEnv } from "../src/env";

const read = (...p: string[]) => readFileSync(join(import.meta.dir, "..", ...p), "utf8");
const client = read("src", "web", "client.ts");
const wallet = read("src", "web", "wallet.ts");

describe("fonts are self-hosted", () => {
  test("Geist and Geist Mono come only from /assets/fonts on this server; no outside font service", () => {
    expect(PAGE_CSS).toContain('@font-face{font-family:Geist;src:url(/assets/fonts/geist.woff2) format("woff2")');
    expect(PAGE_CSS).toContain('@font-face{font-family:"Geist Mono";src:url(/assets/fonts/geist-mono.woff2) format("woff2")');
    expect(PAGE_CSS).not.toMatch(/https?:\/\//); // no URL to anywhere else in the page's styles
    expect(PAGE_CSS).not.toContain("googleapis");
  });

  test("the font files are real WOFF2 files, shipped with their licence", () => {
    for (const f of Object.values(SIGNER_FONTS)) expect(new TextDecoder().decode(f.slice(0, 4))).toBe("wOF2");
    expect(Object.keys(SIGNER_FONTS).sort()).toEqual(["geist-mono.woff2", "geist.woff2"]);
    expect(read("src", "web", "fonts", "LICENSE")).toContain("SIL Open Font License, Version 1.1");
  });

  test("the passkey page needs no policy change for them: default-src 'self' already covers fonts", () => {
    expect(SIGNER_CSP).toContain("default-src 'self'");
    expect(SIGNER_CSP).not.toContain("font-src");
    expect(WALLET_CSP).toContain("font-src 'self';");
    expect(WALLET_CSP).not.toContain("fonts.reown.com"); // the wallet window uses the page's own Geist now
  });

  test("the font route serves only the two fixed files", async () => {
    const env = parseEnv({
      PUBLIC_URL: "https://sign.example",
      DATABASE_URL: "postgres://unused",
      RHC_RPC_URL: "https://rpc.example",
      CHAIN_ID: "46630",
      FACTORY_ADDRESS: "0x0000000000000000000000000000000000000001",
      ADAPTER_ADDRESS: "0x0000000000000000000000000000000000000002",
      RELAYER_PRIVATE_KEY: "0x01",
      TELEGRAM_BOT_TOKEN: "1:unused",
      TELEGRAM_BOT_USERNAME: "unused",
      TELEGRAM_WEBHOOK_SECRET: "w".repeat(24),
      LINK_SECRET: "l".repeat(32),
    });
    const app = createServer({ deps: {} as never, cards: null, signerJs: "", env });
    const ok = await app.request("/assets/fonts/geist.woff2");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("font/woff2");
    expect((await app.request("/assets/fonts/geist-mono.woff2")).status).toBe(200);
    for (const bad of ["/assets/fonts/LICENSE", "/assets/fonts/..%2Fclient.ts", "/assets/fonts/toString", "/assets/fonts/x.woff2"]) {
      expect((await app.request(bad)).status).toBe(404);
    }
  });
});

describe("the website's look", () => {
  test("monochrome: black panel on grey, light pill buttons, Geist, small mono labels", () => {
    expect(PAGE_CSS).toContain("--page:#858584;--card:#080808");
    expect(PAGE_CSS).toContain("font:15px/1.55 Geist,Arial,sans-serif");
    expect(PAGE_CSS).toContain("border-radius:999px;background:var(--btn);color:var(--btn-fg)");
    expect(PAGE_CSS).not.toContain("prefers-color-scheme"); // one fixed look, like the site
    expect(PAGE_CSS).toContain("@media (max-width:480px)"); // narrow phones and Telegram's browser
  });

  test("the brand line and the footer class are the only markup added; wording and order are unchanged", () => {
    const html = signerPage("tok", { chainId: 46630, rpcUrl: "https://r", bundlerUrl: "", paymasterUrl: "", passkeyServerUrl: "", usdg: "0x1" });
    expect(html).toContain('<p class="brand">COFER</p>');
    expect(html).toContain('<p class="foot"><small>Votes count only when signed with your own key. Exiting with your exact share is always available.</small></p>');
    expect(html).not.toMatch(/\sstyle=/);
  });

  test("status lines: a failure is styled as an error and a finished action as done; progress lines have no tone", () => {
    expect(client).toContain('say(e instanceof Stop ? e.message : failureText(e, handedOff, navigator.onLine), "error");');
    expect(client).toContain('say(`Done. Your key: ${s.address}. Go back to Telegram.`, "ok");');
    expect(client).toContain('say(KEY.waiting);');
    expect(PAGE_CSS).toContain("#status[data-tone=error]{border-left:3px solid var(--alert)}");
    expect(PAGE_CSS).toContain("#status[data-tone=ok]{border-left:3px solid var(--fg)}");
  });
});

describe("the wallet window: themed, and as many wallet choices as possible", () => {
  test("every installed browser wallet by name (EIP-6963), plus WalletConnect with featured wallets first and all wallets", () => {
    expect(wallet).toContain("enableEIP6963: true,");
    expect(wallet).toContain("enableInjected: true,");
    expect(wallet).toContain("enableWalletConnect: true,");
    expect(wallet).toContain('allWallets: "SHOW",');
    expect(wallet).toContain("featuredWalletIds: FEATURED_WALLET_IDS,");
    const ids = [...wallet.matchAll(/^\s+"([0-9a-f]{64})",$/gm)].map((m) => m[1]);
    expect(ids).toHaveLength(9);
    expect(new Set(ids).size).toBe(9);
  });

  test("themed like the site: dark, Geist, light accent, rounded corners", () => {
    expect(wallet).toContain('themeMode: "dark",');
    expect(wallet).toContain('"--w3m-font-family": "Geist, Arial, sans-serif",');
    expect(wallet).toContain('"--w3m-accent": "#e4e4e1",');
    expect(wallet).toContain('"--w3m-border-radius-master": "6px",');
  });

  test("the Coinbase and Base SDKs stay off: Base is switched off before the adapter adds its connectors", () => {
    expect(wallet).toContain("enableCoinbase: false,");
    const off = wallet.indexOf("OptionsController.setEnableBaseAccount(false);");
    expect(off).toBeGreaterThan(-1);
    expect(off).toBeLessThan(wallet.indexOf("new WagmiAdapter("));
    expect(off).toBeLessThan(wallet.indexOf("createAppKit({"));
  });
});
