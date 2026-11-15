/**
 * The signer site checks the key before any member action. Every passkey on a device is a different
 * smart account, so picking the wrong one would sign or send from an account that is not the member
 * (on-chain this fails as NotMember()). The check runs after the key is picked and before
 * anything is signed or sent.
 *
 * Wording follows the member's saved kind: a passkey member reads about their passkey, a wallet
 * member (kernel-ecdsa) reads about their wallet and never about a passkey.
 */

/** Which key the page and the bot talk about. */
export type KeyWord = "passkey" | "wallet";

/** The key word for a saved kind: only "kernel-ecdsa" is a wallet. */
export function keyWordOf(accountKind: string | null | undefined): KeyWord {
  return accountKind === "kernel-ecdsa" ? "wallet" : "passkey";
}

export const WRONG_KEY = "That's not the passkey linked to your Cofer account. Try again and pick a different passkey.";
export const NO_KEY = "You haven't set up your Cofer key yet. Tap Set up my key in Telegram first.";

/** A wallet member connected a different wallet: says exactly which wallet to use. */
export function wrongWalletText(owner: string): string {
  return `That's not the wallet you signed up with. Connect the wallet ${owner} and try again. Nothing was sent.`;
}

/** Same address, ignoring upper/lower case (checksum). */
export function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** The message that stops the action, or null when the signer is the linked key. */
export function signerProblem(linked: string | null | undefined, signer: string, word: KeyWord = "passkey", owner?: string): string | null {
  if (!linked) return NO_KEY;
  if (sameAddress(linked, signer)) return null;
  return word === "wallet" && owner ? wrongWalletText(owner) : WRONG_KEY;
}

/** Before a wallet member's account is built: the connected wallet must be the one that owns it. */
export function walletProblem(owner: string, connected: string): string | null {
  return sameAddress(owner, connected) ? null : wrongWalletText(owner);
}

/** Every line on the signer page and in the bot that names the key. */
export const KEY_TEXT = {
  passkey: {
    waiting: "Waiting for your passkey...",
    confirm: "Confirm with your passkey...",
    approve: "Approve with my passkey",
    claim: (i: number, n: number) => `Confirm claim ${i} of ${n} with your passkey...`,
    signPrompt: "Review the exact action and sign with your passkey.",
  },
  wallet: {
    waiting: "Waiting for your wallet...",
    confirm: "Confirm in your wallet...",
    approve: "Approve with my wallet",
    claim: (i: number, n: number) => `Confirm claim ${i} of ${n} in your wallet...`,
    signPrompt: "Review the exact action and sign with your wallet.",
  },
} as const satisfies Record<KeyWord, unknown>;
