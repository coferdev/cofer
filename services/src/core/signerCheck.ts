/**
 * The signer site checks the key before any member action. Every passkey on a device is a different
 * smart account, so picking the wrong one would sign or send from an account that is not the member
 * (on-chain this fails as NotMember()). The check runs after the passkey is picked and before
 * anything is signed or sent.
 */

export const WRONG_KEY = "That's not the passkey linked to your Cofer account. Try again and pick a different passkey.";
export const NO_KEY = "You haven't set up your Cofer key yet. Tap Set up my key in Telegram first.";

/** Same address, ignoring upper/lower case (checksum). */
export function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** The message that stops the action, or null when the signer is the linked key. */
export function signerProblem(linked: string | null | undefined, signer: string): string | null {
  if (!linked) return NO_KEY;
  return sameAddress(linked, signer) ? null : WRONG_KEY;
}
