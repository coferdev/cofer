import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HttpRequestError } from "viem";
import { BROWSER_FAILED, failureText, isHandOff, MAYBE_SENT, PASSKEY_CANCELLED, retryText, ServerSaid } from "../src/core/retryText";

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
    expect(failureText(bundler, false)).toBe(BROWSER_FAILED);
    expect(failureText(new Error("Details: execution reverted at https://x/KEY"), false)).toBe(BROWSER_FAILED);
    expect(failureText("a thrown string", false)).toBe(BROWSER_FAILED);
    expect(failureText(undefined, false)).toBe(BROWSER_FAILED);
    for (const t of [BROWSER_FAILED, PASSKEY_CANCELLED]) expect(t).not.toMatch(/https?:/);
  });

  test("a cancelled passkey prompt gets its own message, even when a library wraps it", () => {
    const cancel = Object.assign(new Error("The operation either timed out or was not allowed."), { name: "NotAllowedError" });
    expect(failureText(cancel, false)).toBe(PASSKEY_CANCELLED);
    expect(failureText(new Error("passkey failed", { cause: cancel }), false)).toBe(PASSKEY_CANCELLED);
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
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect({ l, ok: l.includes("e instanceof Stop ? e.message") }).toEqual({ l, ok: true });
    expect(src).toContain('throw new ServerSaid(json.error.message ?? "request failed")');
  });
});
