import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inAppBrowser, inAppText } from "../src/core/inAppBrowser";
import { signerPage } from "../src/web/page";

const UA = {
  telegramAndroid:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.6613.127 Mobile Safari/537.36 Telegram-Android/11.1.3 (Google Pixel 8; Android 14; SDK 34; HIGH)",
  iosWebView: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  instagram:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 339.0.3.12.91 (iPhone15,2; iOS 17_5; en_US; en; scale=3.00; 1179x2556)",
  facebook: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/470.0.0.40.108;FBBV/600000000;FBDV/iPhone15,2]",
  facebookAndroid:
    "Mozilla/5.0 (Linux; Android 14; SM-S918B Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.6613.127 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/478.0.0.41.86;]",
  tiktok:
    "Mozilla/5.0 (Linux; Android 13; SM-A536B Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/127.0.6533.103 Mobile Safari/537.36 trill_350102 JsSdk/1.0 NetType/WIFI Channel/googleplay AppName/musical_ly app_version/35.1.2 ByteLocale/en BytedanceWebview/d8a21c6",
  otherAndroidApp:
    "Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.6613.127 Mobile Safari/537.36",
  safariIphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
  chromeIphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/128.0.6613.98 Mobile/15E148 Safari/604.1",
  firefoxIphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/129.0 Mobile/15E148 Safari/605.1.15",
  chromeAndroid: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36",
  samsung: "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36",
  chromeMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  safariMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
  firefoxLinux: "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
};

describe("in-app browser detection", () => {
  test("names the app when its token is in the user agent", () => {
    expect(inAppBrowser(UA.telegramAndroid)).toBe("Telegram");
    expect(inAppBrowser(UA.instagram)).toBe("Instagram");
    expect(inAppBrowser(UA.facebook)).toBe("Facebook");
    expect(inAppBrowser(UA.facebookAndroid)).toBe("Facebook");
    expect(inAppBrowser(UA.tiktok)).toBe("TikTok");
  });

  test("an app's built-in browser it cannot name is still caught (Android WebView, iPhone WebKit without Safari)", () => {
    expect(inAppBrowser(UA.iosWebView)).toBe(""); // e.g. Telegram's own browser on iPhone
    expect(inAppBrowser(UA.otherAndroidApp)).toBe("");
  });

  test("normal browsers are never stopped", () => {
    for (const ua of [UA.safariIphone, UA.chromeIphone, UA.firefoxIphone, UA.chromeAndroid, UA.samsung, UA.chromeMac, UA.safariMac, UA.firefoxLinux]) {
      expect(inAppBrowser(ua)).toBeNull();
    }
  });

  test("the exact message, with and without the app's name", () => {
    expect(inAppText("Telegram")).toBe(
      "Passkeys don't work inside Telegram. Tap the menu (••• or ⋮) and choose Open in browser (on iPhone: Open in Safari), then use this same link there. Nothing was created or sent, and this link still works.",
    );
    expect(inAppText("")).toStartWith("Passkeys don't work inside an app. ");
    expect(inAppText("")).not.toMatch(/https?:/);
  });
});

describe("signer page: in-app stop runs before any passkey or link use", () => {
  const client = readFileSync(join(import.meta.dir, "..", "src", "web", "client.ts"), "utf8");
  const main = client.slice(client.indexOf("async function main()"));

  test("it is checked right after the read-only preview, before the button gets any action", () => {
    const check = main.indexOf("const app = inAppBrowser(navigator.userAgent);");
    expect(check).toBeGreaterThan(main.indexOf('trpc<Preview>("session.preview"'));
    expect(check).toBeLessThan(main.indexOf("const guard = ")); // the guard spends the link (ensureSession) and asks for the passkey
    expect(check).toBeLessThan(main.indexOf("act.onclick"));
    expect(main).toContain("act.hidden = true;\n    throw new Stop(inAppText(app), `in-app browser: ${app || \"unknown app\"}`);");
  });
});

describe("old browser-wallet tickbox is gone", () => {
  const client = readFileSync(join(import.meta.dir, "..", "src", "web", "client.ts"), "utf8");
  const html = signerPage("tok", { chainId: 46630, rpcUrl: "https://r", bundlerUrl: "https://b", paymasterUrl: "https://p", passkeyServerUrl: "https://k", usdg: "0x1" });

  test("no tickbox on the page, and an empty hidden spot is left for Connect wallet", () => {
    expect(html).not.toContain("useWallet");
    expect(html).not.toContain("Use a browser wallet");
    expect(html).toContain('<div id="wallet" hidden></div>');
  });

  test("no raw-wallet branch in the page code: every key is the passkey account", () => {
    for (const gone of ["useWallet", "window.ethereum", "createWalletClient", "sendTransaction", '"eoa"']) expect(client).not.toContain(gone);
  });

  test("sign-up always saves the kind kernel-passkey (the server checks it on-chain)", () => {
    expect(client).toContain('await trpc("me.link", { address: s.address, signature, kind: "kernel-passkey" }, true);');
    expect(client.match(/kind: "(kernel-passkey|safe-webauthn|eoa)"/g)).toEqual(['kind: "kernel-passkey"']); // the only account kind the page sends
  });
});
