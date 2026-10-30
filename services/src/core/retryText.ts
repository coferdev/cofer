/**
 * What the signer site says when a money action (deposit, exit, spend, card) fails. Once the action
 * has been handed to the bundler or the wallet, it may still land on-chain, so a plain retry could
 * send it twice. From that point on the member is told to check first.
 */

export const MAYBE_SENT = "This may have gone through. Check /me or /pot in Telegram before trying again.";

/** The normal message for an error before anything was handed off. */
export function retryText(error: string): string {
  return `Something went wrong: ${error}. You can try again.`;
}

export const PASSKEY_CANCELLED = "The passkey prompt was cancelled. You can try again.";
export const BROWSER_FAILED = "Something went wrong. You can try again.";

/** Error text sent by our own API. The API only sends fixed text, so this is safe to show. */
export class ServerSaid extends Error {}

/** WebAuthn reports a closed or refused passkey prompt as NotAllowedError (also when wrapped by a library). */
function isPasskeyCancel(e: unknown): boolean {
  for (let x = e as { name?: string; cause?: unknown } | undefined, i = 0; x && i < 8; x = x.cause as typeof x, i++) {
    if (x.name === "NotAllowedError" || x.name === "AbortError") return true;
  }
  return false;
}

/**
 * The message for a failed action. Once handed off: the check-first message. Before: our API's own
 * text, or fixed text. Errors raised in the browser (viem, ZeroDev, the bundler) are never shown as
 * is: their text can hold service addresses and is not written for members.
 */
export function failureText(e: unknown, handedOff: boolean): string {
  if (handedOff) return MAYBE_SENT;
  if (e instanceof ServerSaid) return retryText(e.message);
  if (isPasskeyCancel(e)) return PASSKEY_CANCELLED;
  return BROWSER_FAILED;
}

/** True when a JSON-RPC request body (single or batch) hands a user operation to the bundler. */
export function isHandOff(body: unknown): boolean {
  if (typeof body !== "string") return false;
  try {
    const parsed = JSON.parse(body);
    return (Array.isArray(parsed) ? parsed : [parsed]).some((r) => r?.method === "eth_sendUserOperation");
  } catch {
    return false;
  }
}
