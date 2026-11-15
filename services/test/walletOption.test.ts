/**
 * Connect wallet as the second key (kind "kernel-ecdsa"): the saved kind decides the page, the two are
 * never mixed, a wrong wallet is refused by name, a refusal in the wallet reads as cancelled, the
 * passkey page's security policy is unchanged, and Connect wallet off never touches the passkey.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UserRejectedRequestError } from "viem";
import { keyChoice, pagePath } from "../src/core/keyChoice";
import { KEY_TEXT, keyWordOf, NO_KEY, signerProblem, walletProblem, WRONG_KEY, wrongWalletText } from "../src/core/signerCheck";
import { BROWSER_FAILED, failureText, MAYBE_SENT, PASSKEY_CANCELLED, WALLET_CANCELLED } from "../src/core/retryText";
import { chainName, needsAddChain, WALLET_OFF_TEXT, wrongNetworkText } from "../src/core/walletChain";
import { SIGNER_CSP, WALLET_CSP, signerPage } from "../src/web/page";
import { createServer } from "../src/api/server";
import { parseEnv } from "../src/env";

const read = (...p: string[]) => readFileSync(join(import.meta.dir, "..", ...p), "utf8");
const OWNER = "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A";
const OTHER = "0x1563915e194D8CfBA1943570603F7606A3115508";

describe("the saved kind decides the page (never mixed)", () => {
  const actions = ["sign", "deposit", "exit", "claim", "card"];

  test("passkey members never see Connect wallet, on any action, and are sent back from the wallet page", () => {
    for (const purpose of actions) {
      for (const walletOn of [true, false]) {
        expect(keyChoice({ mode: "passkey", purpose, kind: "kernel-passkey", walletOn })).toEqual({ redirect: null, passkey: true, wallet: false, walletOff: false });
        expect(keyChoice({ mode: "wallet", purpose, kind: "kernel-passkey", walletOn })).toEqual({ redirect: "passkey", passkey: false, wallet: false, walletOff: false });
      }
    }
  });

  test("wallet members never see the passkey: sent to the wallet page, which offers only Connect wallet", () => {
    for (const purpose of actions) {
      expect(keyChoice({ mode: "passkey", purpose, kind: "kernel-ecdsa", walletOn: true })).toEqual({ redirect: "wallet", passkey: false, wallet: false, walletOff: false });
      expect(keyChoice({ mode: "wallet", purpose, kind: "kernel-ecdsa", walletOn: true })).toEqual({ redirect: null, passkey: false, wallet: true, walletOff: false });
    }
  });

  test("with Connect wallet off, a wallet member is told so (never offered a passkey instead)", () => {
    expect(keyChoice({ mode: "wallet", purpose: "deposit", kind: "kernel-ecdsa", walletOn: false })).toEqual({ redirect: null, passkey: false, wallet: false, walletOff: true });
  });

  test("old and missing kinds stay on the passkey page exactly as before", () => {
    for (const kind of ["eoa", "safe-webauthn", null, undefined]) {
      expect(keyChoice({ mode: "passkey", purpose: "deposit", kind, walletOn: true })).toEqual({ redirect: null, passkey: true, wallet: false, walletOff: false });
    }
  });

  test("sign-up is the only choice: both buttons on the passkey page (wallet only if on); the wallet page offers only the wallet", () => {
    expect(keyChoice({ mode: "passkey", purpose: "onboard", kind: null, walletOn: true })).toEqual({ redirect: null, passkey: true, wallet: true, walletOff: false });
    expect(keyChoice({ mode: "passkey", purpose: "onboard", kind: null, walletOn: false })).toEqual({ redirect: null, passkey: true, wallet: false, walletOff: false });
    expect(keyChoice({ mode: "wallet", purpose: "onboard", kind: null, walletOn: true })).toEqual({ redirect: null, passkey: false, wallet: true, walletOff: false });
  });

  test("the other page keeps the same link, encoded", () => {
    expect(pagePath("wallet", "a.b-c_d")).toBe("/w/a.b-c_d");
    expect(pagePath("passkey", "a/b")).toBe("/s/a%2Fb");
  });
});

describe("wrong wallet, wording by kind", () => {
  test("a different wallet is refused in plain words that name the wallet to use", () => {
    expect(walletProblem(OWNER, OWNER.toLowerCase())).toBeNull();
    expect(walletProblem(OWNER, OTHER)).toBe(wrongWalletText(OWNER));
    expect(wrongWalletText(OWNER)).toBe(`That's not the wallet you signed up with. Connect the wallet ${OWNER} and try again. Nothing was sent.`);
    expect(signerProblem("0xaa", "0xbb", "wallet", OWNER)).toBe(wrongWalletText(OWNER));
  });

  test("passkey wording is unchanged; wallet wording never says passkey", () => {
    expect(signerProblem("0xaa", "0xbb")).toBe(WRONG_KEY);
    expect(signerProblem(null, "0xbb", "wallet")).toBe(NO_KEY);
    expect(KEY_TEXT.passkey).toMatchObject({ waiting: "Waiting for your passkey...", confirm: "Confirm with your passkey...", approve: "Approve with my passkey", signPrompt: "Review the exact action and sign with your passkey." });
    const wallet: string[] = [...(Object.values(KEY_TEXT.wallet) as unknown[]).filter((v): v is string => typeof v === "string"), KEY_TEXT.wallet.claim(1, 2), wrongWalletText(OWNER)];
    for (const t of wallet) expect(t.toLowerCase()).not.toContain("passkey");
    expect(KEY_TEXT.wallet.claim(1, 2)).toBe("Confirm claim 1 of 2 in your wallet...");
  });

  test("the bot picks the sign prompt from the member's saved kind", () => {
    expect(keyWordOf("kernel-ecdsa")).toBe("wallet");
    for (const k of ["kernel-passkey", "eoa", null, undefined]) expect(keyWordOf(k)).toBe("passkey");
    const bot = read("src", "bot", "bot.ts");
    expect(bot).toContain("await ephemeral(ctx, KEY_TEXT[keyWordOf(u.accountKind)].signPrompt, {");
    expect(bot).not.toContain('"Review the exact action and sign with your passkey."');
  });
});

describe("a refusal in the wallet reads as cancelled", () => {
  test("EIP-1193 code 4001, viem's UserRejectedRequestError, and a closed wallet window", () => {
    expect(WALLET_CANCELLED).toBe("The request was cancelled in your wallet. Nothing was sent. You can try again.");
    expect(failureText(Object.assign(new Error("User rejected the request."), { code: 4001 }), false)).toBe(WALLET_CANCELLED);
    expect(failureText(new UserRejectedRequestError(new Error("no")), false)).toBe(WALLET_CANCELLED);
    expect(failureText(new Error("signing failed", { cause: { code: 4001, message: "rejected" } }), false)).toBe(WALLET_CANCELLED); // wrapped by the SDK
    expect(failureText(Object.assign(new Error("wallet window closed"), { name: "UserRejectedRequestError", code: 4001 }), false)).toBe(WALLET_CANCELLED);
    expect(failureText(new UserRejectedRequestError(new Error("no")), false)).not.toBe(BROWSER_FAILED);
  });

  test("the order is kept: after the hand-off the member checks first; the passkey cancel is unchanged", () => {
    expect(failureText(Object.assign(new Error("x"), { code: 4001 }), true)).toBe(MAYBE_SENT);
    expect(failureText(Object.assign(new Error("x"), { name: "NotAllowedError" }), false)).toBe(PASSKEY_CANCELLED);
  });
});

describe("the wallet goes onto the page's Robinhood Chain", () => {
  test("the network to switch to comes from the page's chain id", () => {
    expect(chainName(46630)).toBe("Robinhood Chain Testnet");
    expect(chainName(4663)).toBe("Robinhood Chain");
    expect(wrongNetworkText(46630)).toBe("Your wallet is on a different network. Switch it to Robinhood Chain Testnet and try again. Nothing was sent.");
  });

  test("the network is added only when the wallet does not know it (4902, also wrapped, or the unknown-chain text)", () => {
    expect(needsAddChain({ code: 4902 })).toBe(true);
    expect(needsAddChain(new Error("switch failed", { cause: { code: 4902 } }))).toBe(true);
    expect(needsAddChain(new Error("Unrecognized chain ID \"0xb626\". Try adding the chain using wallet_addEthereumChain first."))).toBe(true);
    expect(needsAddChain({ code: 4001 })).toBe(false); // the member said no: never add behind their back
    expect(needsAddChain(new Error("timeout"))).toBe(false);
  });

  test("the page switches, adds only on that error, then checks the network again before anything is signed", () => {
    const client = read("src", "web", "client.ts");
    const fn = client.slice(client.indexOf("async function connectWallet()"), client.indexOf("async function walletSigner("));
    expect(fn).toContain("await wallet.switchChain({ id: chain.id });");
    expect(fn).toContain("if (!needsAddChain(e)) throw e;\n      await wallet.addChain({ chain });");
    expect(fn).toContain("if ((await wallet.getChainId()) !== chain.id) throw new Stop(wrongNetworkText(chain.id), ");
  });
});

describe("signer page code: the wallet path", () => {
  const client = read("src", "web", "client.ts");

  test("on the wallet page a member action never asks for a passkey: memberSigner returns the wallet signer first", () => {
    const fn = client.slice(client.indexOf("async function memberSigner()"), client.indexOf("const IS_POT_ABI"));
    expect(fn.indexOf('if (MODE === "wallet") {')).toBeLessThan(fn.indexOf("await getSigner()"));
    expect(fn).toContain("return walletSigner(me.address);");
  });

  test("a wrong wallet is refused before any account is built or anything is signed, and is disconnected", () => {
    const fn = client.slice(client.indexOf("async function walletSigner("), client.indexOf("/** Signer for a member action"));
    expect(fn).toContain('functionName: "ecdsaValidatorStorage", args: [linked]');
    const refuse = fn.indexOf("const problem = walletProblem(expected, owner);");
    expect(refuse).toBeGreaterThan(-1);
    expect(refuse).toBeLessThan(fn.indexOf("signerToEcdsaValidator("));
    expect(fn).toContain("await w.disconnect();");
  });

  test("the wallet account is the Kernel account (wallet as main ECDSA signer), sponsored by the same client as the passkey", () => {
    const fn = client.slice(client.indexOf("async function walletSigner("), client.indexOf("/** Signer for a member action"));
    expect(fn).toContain("plugins: { sudo: validator }, entryPoint, kernelVersion: KERNEL_V3_1");
    expect(fn).toContain("const own = await walletAccountAddress(owner);");
    expect(fn).toContain("return kernelSigner(account, kernelClient(account));");
  });

  test("wallet sign-up: deploy (sponsored), sign the link message, then link as kernel-ecdsa, in that order", () => {
    const start = client.indexOf('if (ex.purpose === "onboard" && MODE === "wallet") {');
    const flow = client.slice(start, client.indexOf('if (ex.purpose === "onboard") {', start));
    const order = ["await walletSigner();", 'await s.send([{ to: s.address, data: "0x" }]);', 'trpc<{ message: string }>("me.linkMessage", {})', "await s.signMessage(message);", 'kind: "kernel-ecdsa"'];
    let at = -1;
    for (const step of order) {
      const i = flow.indexOf(step);
      expect(i).toBeGreaterThan(at);
      at = i;
    }
    expect(flow).not.toContain("getSigner(");
  });

  test("the passkey path is unchanged: same passkey account, same checked send, same register on sign-up", () => {
    expect(client).toContain("const { account, client } = await passkeyAccount(register ? WebAuthnMode.Register : WebAuthnMode.Login);");
    expect(client).toContain("validatorContractVersion: PasskeyValidatorContractVersion.V0_0_3_PATCHED,");
    expect(client).toContain('if (!callDataCarries(callData, calls, account.address)) throw new Stop(CALL_MISMATCH_TEXT, "encoded user operation does not carry the checked calls");');
    expect(client).toContain("const s = await getSigner(true);");
  });

  test("the wallet file is loaded only on the wallet page, only from the site itself", () => {
    const fn = client.slice(client.indexOf("function loadWallet()"), client.indexOf("/** Connects the member's wallet"));
    expect(fn).toContain('if (MODE !== "wallet" || !cfg.walletOn || !cfg.reownProjectId || cfg.walletJs !== "/assets/wallet.js") return Promise.reject(');
    expect(client).not.toMatch(/from ["']@reown|from ["']@wagmi|from ["']wagmi/); // AppKit is never in the passkey bundle
  });
});

describe("security policy: the passkey page is unchanged, the wallet page opens only what Connect wallet needs", () => {
  test("SIGNER_CSP is exactly as before (no new source of any kind)", () => {
    const parts = SIGNER_CSP.split(";").map((d) => d.trim());
    expect(parts.filter((d) => !d.startsWith("style-src"))).toEqual(["default-src 'self'", "script-src 'self'", "connect-src *", "frame-ancestors 'none'"]);
    expect(SIGNER_CSP).not.toMatch(/unsafe-inline|reown|walletconnect|web3modal/);
  });

  test("WALLET_CSP: scripts still only from the site; the rest is the listed Reown/WalletConnect hosts", () => {
    expect(WALLET_CSP.split("; ")).toEqual([
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https://api.web3modal.org https://*.walletconnect.com https://*.walletconnect.org https://*.reown.com",
      "font-src 'self' https://fonts.reown.com",
      "connect-src * wss:",
      "frame-src https://verify.walletconnect.org https://verify.walletconnect.com",
      "frame-ancestors 'none'",
    ]);
  });

  test("the wallet page shell carries the wallet settings; the passkey page never carries the project ID", () => {
    const base = { chainId: 46630, rpcUrl: "https://r", bundlerUrl: "", paymasterUrl: "", passkeyServerUrl: "", usdg: "0x1", walletOn: true };
    const passkey = signerPage("tok", { ...base, mode: "passkey" });
    const wallet = signerPage("tok", { ...base, mode: "wallet", reownProjectId: "0".repeat(32), walletJs: "/assets/wallet.js" });
    expect(passkey).not.toContain("reownProjectId");
    expect(wallet).toContain('"reownProjectId":"00000000000000000000000000000000"');
    expect(wallet).toContain('"mode":"wallet"');
  });
});

describe("routes: Connect wallet on, and off", () => {
  const PROJECT = "0123456789abcdef0123456789abcdef"; // a made-up ID of the right shape
  const env = (reown?: string) =>
    parseEnv({
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
      REOWN_PROJECT_ID: reown,
    });
  const server = (reown: string | undefined, walletJs: string | null) => createServer({ deps: {} as never, cards: null, signerJs: "//signer", walletJs, env: env(reown) });

  test("on: /w/ gets the wallet policy and settings, /assets/wallet.js is served; /s/ keeps the passkey policy", async () => {
    const app = server(PROJECT, "//wallet");
    const s = await app.request("/s/tok");
    expect(s.headers.get("content-security-policy")).toBe(SIGNER_CSP);
    expect(await s.text()).not.toContain(PROJECT);
    const w = await app.request("/w/tok");
    expect(w.headers.get("content-security-policy")).toBe(WALLET_CSP);
    const html = await w.text();
    expect(html).toContain(`"reownProjectId":"${PROJECT}"`);
    expect(html).toContain('"walletJs":"/assets/wallet.js"');
    expect(html).toContain('"walletOn":true');
    expect(await (await app.request("/assets/wallet.js")).text()).toBe("//wallet");
  });

  test("off (no REOWN_PROJECT_ID, or the wallet file did not build): passkey page unchanged, /w/ stays strict and says off", async () => {
    for (const app of [server(undefined, "//wallet"), server(PROJECT, null)]) {
      const s = await app.request("/s/tok");
      expect(s.status).toBe(200);
      expect(s.headers.get("content-security-policy")).toBe(SIGNER_CSP);
      expect(await s.text()).toContain('"walletOn":false');
      const w = await app.request("/w/tok");
      expect(w.headers.get("content-security-policy")).toBe(SIGNER_CSP);
      const html = await w.text();
      expect(html).not.toContain("reownProjectId");
      expect(html).toContain('"walletOn":false');
      expect((await app.request("/assets/wallet.js")).status).toBe(404);
    }
    expect(WALLET_OFF_TEXT).toBe("Connect wallet is not available right now. Nothing was sent. Try again later.");
  });

  test("REOWN_PROJECT_ID is optional; a value of the wrong shape stops start-up with a clear message", () => {
    expect(env(undefined).REOWN_PROJECT_ID).toBeUndefined();
    expect(() => env("not-an-id")).toThrow("REOWN_PROJECT_ID must be the 32-character project ID from the Reown dashboard");
  });

  test("start-up: Connect wallet is built only with REOWN_PROJECT_ID, and a missing ID or failed build is said plainly", () => {
    const idx = read("src", "index.ts");
    expect(idx).toContain('console.log("[api] REOWN_PROJECT_ID is not set: Connect wallet is off. Passkey sign-up and signing work as before.');
    expect(idx).toContain("walletJs = await buildWalletBundle().catch((err) => {");
    expect(idx).toContain('logError("api wallet bundle (Connect wallet is off; passkeys work as before)", err);');
  });
});
