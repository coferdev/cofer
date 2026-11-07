/**
 * The statement members read before they start (the owner's text). Shown as plain text on /start in
 * the private chat, above the key set-up button, and pointed to from /help. The staff copy is in
 * docs/runbook.md. The beta limit and the network name come from the code, so they cannot drift.
 */
import { BETA_DEPOSIT_CAP_USDG, usdgText } from "./betaCap";
import { NETWORK_NAME } from "./exitDestination";

export const NOTICE_TITLE = "Before you start";

/** The second non-empty line, quotes included. */
export const NOTICE_SUBTITLE = '"Read This Statement"';

/** The last line of /help. */
export const NOTICE_POINTER = "Read the statement: send /start to me in a private chat.";

/** The notice text; `cap` is the beta limit in USDG units (null: no limit). */
export function noticeText(cap: bigint | null = BETA_DEPOSIT_CAP_USDG, network: string = NETWORK_NAME): string {
  const beta =
    cap === null
      ? "• Cofer is in beta. Stocks can lose value. This is software for a group to manage its own money, not financial advice."
      : `• Cofer is in beta: each group is limited to ${usdgText(cap)} USDG while we test. Stocks can lose value. This is software for a group to manage its own money, not financial advice.`;
  return [
    NOTICE_TITLE,
    "",
    NOTICE_SUBTITLE,
    "",
    `Cofer is a shared money account for your Telegram group, on ${network}.`,
    "",
    `• Your key: when you set up, Cofer creates an address for you on ${network}, protected by your passkey (Face ID or fingerprint). There is no seed phrase. This bot never holds your keys or your money.`,
    `• ${network} only: send USDG to that address on ${network} only. Money sent on any other network will not arrive.`,
    "• Leaving is always open: any member can /exit at any time and get their exact share. Nobody can block it, not even us.",
    `• Where it goes: your exit goes to your own Cofer address, or to a different address you type. That must be a wallet that supports ${network}. Many exchange deposit addresses do not.`,
    "• Your passkey is your key. There is no recovery: if you lose it and have no backup, you lose access to your money, like a lost seed phrase. Make sure your phone or browser backs up your passkeys.",
    beta,
  ].join("\n");
}

export const NOTICE_TEXT = noticeText();
