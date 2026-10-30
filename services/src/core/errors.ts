/**
 * What may reach a Telegram chat, and what goes to logs.
 *  - Only UserError messages (fixed text written for members) are ever shown.
 *  - Anything else becomes a fixed sentence: viem errors carry the RPC URL in their message,
 *    and that URL can hold an API key.
 *  - Logs go through redact(), which removes every URL.
 */
import { BaseError, ContractFunctionRevertedError, ExecutionRevertedError } from "viem";

/** An error whose message is safe to show in a chat. */
export class UserError extends Error {}

export const RPC_ERROR_TEXT = "Couldn't reach the chain just now. Nothing was proposed. Try again in a minute.";
/** Same, for places that are not about a vote (the signer API). */
export const RPC_UNREACHABLE_TEXT = "Couldn't reach the chain just now. Try again in a minute.";
export const GENERIC_ERROR_TEXT = "Something went wrong on our side. Try again in a minute.";

/**
 * "revert": the call reached the chain and the contract refused it (a broken pool, a stale feed).
 * "rpc": anything else. Fail closed: an error we cannot place is never read as "no pool".
 */
export function errorKind(e: unknown): "revert" | "rpc" {
  if (!(e instanceof BaseError)) return "rpc";
  if (e.walk((x) => x instanceof ContractFunctionRevertedError || x instanceof ExecutionRevertedError)) return "revert";
  // Some nodes report a capped eth_call running out of gas without an "execution reverted" code.
  if (/out of gas|gas required exceeds/i.test(e.details ?? "")) return "revert";
  return "rpc";
}

/** The contract's custom error name (e.g. "StalePrice"), if the call reverted with one. */
export function revertName(e: unknown): string | undefined {
  if (!(e instanceof BaseError)) return undefined;
  const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
  return r instanceof ContractFunctionRevertedError ? r.data?.errorName : undefined;
}

/** The only text a bot reply (or, with RPC_UNREACHABLE_TEXT, an API response) may contain for a caught error. */
export function userMessage(e: unknown, rpcText = RPC_ERROR_TEXT): string {
  if (e instanceof UserError) return e.message;
  return errorKind(e) === "rpc" ? rpcText : GENERIC_ERROR_TEXT;
}

/** Removes every URL (RPC endpoints can carry API keys in the path or query). */
export function redact(text: string): string {
  return text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "<url>");
}

/** A copy of `e` that is safe to store or log: same name, URLs removed from message and stack, no cause. */
export function safeError(e: unknown): Error {
  const name = e instanceof Error ? e.name : "Error";
  const out = new Error(redact(e instanceof Error ? e.message : String(e)));
  out.name = name;
  out.stack = redact(e instanceof Error && e.stack ? e.stack : `${name}: ${out.message}`);
  return out;
}

/**
 * Wraps a background job so a failure leaves the job as safeError(e). BullMQ stores a failed job's
 * message and stack in Redis, so they must not hold URLs. It still throws, so retries are unchanged.
 */
export function safeJob<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      throw safeError(e);
    }
  };
}

export function logError(scope: string, e: unknown): void {
  const text = e instanceof Error ? (e.stack ?? `${e.name}: ${e.message}`) : String(e);
  console.error(`[${scope}]`, redact(text));
}
