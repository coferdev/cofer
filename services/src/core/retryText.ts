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

/** The message for a failed action: the check-first message once it was handed off, else the normal retry. */
export function failureText(error: string, handedOff: boolean): string {
  return handedOff ? MAYBE_SENT : retryText(error);
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
