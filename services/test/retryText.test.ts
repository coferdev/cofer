import { describe, expect, test } from "bun:test";
import { failureText, isHandOff, MAYBE_SENT, retryText } from "../src/core/retryText";

describe("safe retries on money actions", () => {
  test("after the hand-off the member is told to check first, with the exact message", () => {
    expect(MAYBE_SENT).toBe("This may have gone through. Check /me or /pot in Telegram before trying again.");
    expect(failureText("timeout", true)).toBe(MAYBE_SENT);
  });

  test("before the hand-off the normal retry message stays", () => {
    expect(failureText("passkey cancelled", false)).toBe("Something went wrong: passkey cancelled. You can try again.");
    expect(failureText("x", false)).toBe(retryText("x"));
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
