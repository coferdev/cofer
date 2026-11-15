/**
 * What the signer site says when a money action (deposit, exit, spend, card) fails. Once the action
 * has been handed to the bundler or the wallet, it may still land on-chain, so a plain retry could
 * send it twice. From that point on the member is told to check first.
 */

import { refusalText } from "./refusals";

export const MAYBE_SENT = "This may have gone through. Check /me or /pot in Telegram before trying again.";

/** The normal message for an error before anything was handed off. */
export function retryText(error: string): string {
  return `Something went wrong: ${error}. You can try again.`;
}

export const PASSKEY_CANCELLED = "The passkey prompt was cancelled. You can try again.";
export const WALLET_CANCELLED = "The request was cancelled in your wallet. Nothing was sent. You can try again.";
export const PASSKEY_UNSUPPORTED =
  "This browser or device can't use passkeys. Open the link in Safari or Chrome on a phone or computer that supports passkeys. Nothing was sent.";
export const PASSKEY_DOMAIN_REFUSED = "Passkeys are not allowed on this web address yet. This is a setting on our side, not your device. Nothing was sent. Try again later.";
export const OFFLINE_TEXT = "Couldn't reach the network. Check your internet connection, then try again. Nothing was sent.";
/** The fallback for a browser-side error we cannot place. */
export const BROWSER_FAILED = "Something went wrong. You can try again.";

/** Error text sent by our own API. The API only sends fixed text, so this is safe to show. */
export class ServerSaid extends Error {}

type ErrLike = { name?: unknown; message?: unknown; status?: unknown; code?: unknown; cause?: unknown };

/** The error and up to 7 causes under it (libraries wrap the browser's own error). */
function chain(e: unknown): ErrLike[] {
  const out: ErrLike[] = [];
  for (let x = e as ErrLike | undefined, i = 0; x && typeof x === "object" && i < 8; x = x.cause as ErrLike | undefined, i++) out.push(x);
  return out;
}

/**
 * What kind of browser-side failure this is, read from the WebAuthn error names (kept by the passkey
 * library when it wraps them) and from fetch failures. Never from text we show.
 */
function browserCause(e: unknown, online: boolean): "offline" | "walletCancelled" | "cancelled" | "domain" | "unsupported" | "network" | null {
  if (!online) return "offline";
  const errs = chain(e);
  const has = (...names: string[]) => errs.some((x) => names.includes(String(x.name)));
  // the member said no in their wallet (EIP-1193 code 4001; viem names it UserRejectedRequestError)
  if (errs.some((x) => x.code === 4001) || has("UserRejectedRequestError")) return "walletCancelled";
  // a closed or refused passkey prompt
  if (has("NotAllowedError", "AbortError")) return "cancelled";
  // the site's address does not match the passkey's domain (rpId), or the page is not on https
  if (has("SecurityError")) return "domain";
  // no passkey support in this browser, or no authenticator that can make one
  if (has("NotSupportedError", "ConstraintError") || errs.some((x) => x.message === "WebAuthn is not supported in this browser")) return "unsupported";
  // a request that never got an answer: fetch fails with a TypeError, viem wraps it as HttpRequestError without a status
  if (errs.some((x) => x.name === "HttpRequestError" && x.status === undefined)) return "network";
  if (errs.some((x) => x.name === "TypeError" && /Failed to fetch|Load failed|NetworkError|network connection/i.test(String(x.message)))) return "network";
  return null;
}

/**
 * The message for a failed action. A known contract refusal: its plain sentence (refusals.ts).
 * Otherwise, once handed off: the check-first message. Before: our API's own text, a plain
 * sentence for a common browser-side cause (offline, cancelled, wrong domain, no passkey support),
 * or the fixed fallback. Errors raised in the browser (viem, ZeroDev, the bundler) are never shown
 * as is: their text can hold service addresses and is not written for members.
 * `online` is the browser's navigator.onLine (the page passes it; true when unknown).
 */
export function failureText(e: unknown, handedOff: boolean, online = true): string {
  // a known contract refusal (core/refusals.ts) means the call was refused: nothing went through
  const refused = refusalText(e);
  if (refused) return refused;
  if (handedOff) return MAYBE_SENT;
  if (e instanceof ServerSaid) return retryText(e.message);
  switch (browserCause(e, online)) {
    case "offline":
    case "network":
      return OFFLINE_TEXT;
    case "walletCancelled":
      return WALLET_CANCELLED;
    case "cancelled":
      return PASSKEY_CANCELLED;
    case "domain":
      return PASSKEY_DOMAIN_REFUSED;
    case "unsupported":
      return PASSKEY_UNSUPPORTED;
    default:
      return BROWSER_FAILED;
  }
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

/** Shown once the passkey (or wallet) has been used and the transaction is on its way. */
export const SENDING_TEXT = "Sending... this can take up to a minute. Keep this page open.";
