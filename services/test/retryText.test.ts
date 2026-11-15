import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HttpRequestError } from "viem";
import {
  BROWSER_FAILED,
  failureText,
  isHandOff,
  MAYBE_SENT,
  OFFLINE_TEXT,
  PASSKEY_CANCELLED,
  PASSKEY_DOMAIN_REFUSED,
  PASSKEY_UNSUPPORTED,
  retryText,
  ServerSaid,
} from "../src/core/retryText";

/** A browser error as the WebAuthn API raises it (a DOMException-like object with a name). */
const named = (name: string, message = "x") => Object.assign(new Error(message), { name });

describe("safe retries on money actions", () => {
  test("after the hand-off the member is told to check first, with the exact message", () => {
    expect(MAYBE_SENT).toBe("This may have gone through. Check /me or /pot in Telegram before trying again.");
    expect(failureText(new Error("timeout"), true)).toBe(MAYBE_SENT);
    expect(failureText(new ServerSaid("only members can propose"), true)).toBe(MAYBE_SENT);
  });

  test("before the hand-off, text from our own API is shown with the normal retry message", () => {
    expect(failureText(new ServerSaid("only members can propose"), false)).toBe("Something went wrong: only members can propose. You can try again.");
    expect(failureText(new ServerSaid("x"), false)).toBe(retryText("x"));
  });

  test("errors raised in the browser are never shown as is", () => {
    const bundler = new HttpRequestError({ url: "https://rpc.zerodev.app/api/v3/PROJECT123/chain/4663", details: "fetch failed" });
    expect(failureText(bundler, false)).toBe(OFFLINE_TEXT); // no answer at all: a plain sentence, never the URL
    const refusedByService = new HttpRequestError({ url: "https://rpc.zerodev.app/api/v3/PROJECT123/chain/4663", status: 403, details: "forbidden" });
    expect(failureText(refusedByService, false)).toBe(BROWSER_FAILED); // the service answered: not a network problem
    expect(failureText(new Error("Details: execution reverted at https://x/KEY"), false)).toBe(BROWSER_FAILED);
    expect(failureText("a thrown string", false)).toBe(BROWSER_FAILED);
    expect(failureText(undefined, false)).toBe(BROWSER_FAILED);
    for (const t of [BROWSER_FAILED, PASSKEY_CANCELLED, PASSKEY_UNSUPPORTED, PASSKEY_DOMAIN_REFUSED, OFFLINE_TEXT]) expect(t).not.toMatch(/https?:/);
  });

  test("a cancelled passkey prompt gets its own message, even when a library wraps it", () => {
    const cancel = Object.assign(new Error("The operation either timed out or was not allowed."), { name: "NotAllowedError" });
    expect(failureText(cancel, false)).toBe(PASSKEY_CANCELLED);
    expect(failureText(new Error("passkey failed", { cause: cancel }), false)).toBe(PASSKEY_CANCELLED);
  });

  test("the exact plain sentences for common browser-side causes", () => {
    expect(PASSKEY_UNSUPPORTED).toBe(
      "This browser or device can't use passkeys. Open the link in Safari or Chrome on a phone or computer that supports passkeys. Nothing was sent.",
    );
    expect(PASSKEY_DOMAIN_REFUSED).toBe("Passkeys are not allowed on this web address yet. This is a setting on our side, not your device. Nothing was sent. Try again later.");
    expect(OFFLINE_TEXT).toBe("Couldn't reach the network. Check your internet connection, then try again. Nothing was sent.");
    expect(BROWSER_FAILED).toBe("Something went wrong. You can try again.");
  });

  test("no passkey support: the browser's NotSupportedError or ConstraintError, or the library's own check", () => {
    expect(failureText(named("NotSupportedError"), false)).toBe(PASSKEY_UNSUPPORTED);
    expect(failureText(named("ConstraintError"), false)).toBe(PASSKEY_UNSUPPORTED);
    expect(failureText(new Error("WebAuthn is not supported in this browser"), false)).toBe(PASSKEY_UNSUPPORTED);
    expect(failureText(new Error("passkey failed", { cause: named("NotSupportedError") }), false)).toBe(PASSKEY_UNSUPPORTED); // wrapped by a library
  });

  test("wrong domain or not https: the browser's SecurityError, also when wrapped", () => {
    expect(failureText(named("SecurityError", "The RP ID is invalid for this domain"), false)).toBe(PASSKEY_DOMAIN_REFUSED);
    expect(failureText(new Error("register failed", { cause: named("SecurityError") }), false)).toBe(PASSKEY_DOMAIN_REFUSED);
  });

  test("offline or no answer: the browser says offline, or a fetch never got a reply", () => {
    expect(failureText(new Error("anything"), false, false)).toBe(OFFLINE_TEXT);
    expect(failureText(new TypeError("Failed to fetch"), false)).toBe(OFFLINE_TEXT); // Chrome
    expect(failureText(new TypeError("Load failed"), false)).toBe(OFFLINE_TEXT); // Safari
    expect(failureText(new TypeError("NetworkError when attempting to fetch resource."), false)).toBe(OFFLINE_TEXT); // Firefox
    expect(failureText(new TypeError("Cannot read properties of undefined"), false)).toBe(BROWSER_FAILED); // a code error, not the network
  });

  test("the order is kept: after the hand-off, check first; our API's text wins over the browser's state", () => {
    expect(failureText(named("SecurityError"), true)).toBe(MAYBE_SENT);
    expect(failureText(new TypeError("Failed to fetch"), true, false)).toBe(MAYBE_SENT);
    expect(failureText(new ServerSaid("link already used"), false, false)).toBe(retryText("link already used"));
  });

  test("only eth_sendUserOperation counts as the hand-off to the bundler", () => {
    expect(isHandOff(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendUserOperation", params: [] }))).toBe(true);
    expect(isHandOff(JSON.stringify([{ method: "eth_chainId" }, { method: "eth_sendUserOperation" }]))).toBe(true);
    expect(isHandOff(JSON.stringify({ method: "eth_estimateUserOperationGas" }))).toBe(false);
    expect(isHandOff(JSON.stringify({ method: "eth_getUserOperationReceipt" }))).toBe(false);
    expect(isHandOff("not json")).toBe(false);
    expect(isHandOff(undefined)).toBe(false);
  });
});

describe("signer page source guard", () => {
  test("the page never shows an error's own text, except our API's and its own stops", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "web", "client.ts"), "utf8");
    const lines = src.split("\n").filter((l) => /\be\??\.message\b/.test(l));
    expect(lines).toEqual(["  say(e instanceof Stop ? e.message : failureText(e, handedOff, navigator.onLine));"]); // only inside showFailure, and only a Stop's own text
    expect(src).toContain('throw new ServerSaid(json.error.message ?? "request failed")');
    // every failure the page shows goes through showFailure
    expect(src).toContain("showFailure(e, money && handedOff);");
    expect(src).toContain("main().catch((e) => showFailure(e, false));");
    const outside = src.replace(/function showFailure[\s\S]*?\n\}\n/, "");
    expect(outside).not.toContain("failureText(e"); // failureText is used only inside showFailure
  });

  test("the full original error (or a stop's recorded reason) goes to the browser's own console, the member sees safe text", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "web", "client.ts"), "utf8");
    const fn = /function showFailure\(e: unknown, handedOff: boolean\) \{([\s\S]*?)\n\}/.exec(src)![1]!;
    // a Stop logs only its detail (a plain Stop has none and stays silent); anything else logs the original error
    expect(fn).toContain("const logged = e instanceof Stop ? e.detail : e;");
    expect(fn).toContain('if (logged !== undefined) console.error("[cofer signer]", logged);');
    expect(fn).toContain("say(e instanceof Stop ? e.message : failureText(e, handedOff, navigator.onLine));");
    expect(fn.indexOf("instanceof Stop")).toBeLessThan(fn.indexOf("console.error"));
    expect(src.match(/console\.(error|log|warn)\(/g)).toEqual(["console.error("]); // the only console call on the page
  });

  test("a vote-check refusal records its exact reason, members still read the fixed text", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "web", "client.ts"), "utf8");
    expect(src).toContain("throw new Stop(VOTE_MISMATCH_TEXT, `vote check failed: ${check.problem}`);");
    expect(src).toMatch(/throw new Stop\(VOTE_MISMATCH_TEXT, `vote check failed: \$\{check\.envelope\.pot\} is not a Cofer pot`\)/);
  });
});
