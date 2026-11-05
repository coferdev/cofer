/**
 * /exit in the private chat with the bot: a member can exit without the group, even if the group was
 * deleted. Pots and memberships live in the database (written by the indexer from chain events), not
 * in Telegram, so the member's pots are found from their key alone. Each button is a plain `url`
 * button with its own one-time signer link (never a Mini App).
 */
import { InlineKeyboard } from "grammy";
import { assertNoMiniApp } from "./keyboards";

export interface ExitPot {
  address: string;
  title: string;
}

export const EXIT_TEXT = "Take your exact share of everything the group holds (USDG and any stocks, as they are). No vote needed. Never paused.";
export const EXIT_PICK_TEXT = "You are in more than one group account. Pick the one to exit with your exact share (USDG and any stocks, as they are). No vote needed. Never paused.";
export const NO_POTS_TEXT = "You are not a member of any group account. If you joined in the last few minutes, try again shortly.";
/** Added to /exit in a group, so members know they do not need the group to leave. */
export const EXIT_IN_PRIVATE_NOTE = "You can also send /exit to me in a private chat, even if this group is gone.";
/** Telegram allows 100 buttons per message; far more than any member needs. */
export const MAX_EXIT_BUTTONS = 50;

const MAX_TITLE = 24;

/** "Exit Trip fund (0x2D33…8A45)": the group name, shortened, and the pot's short address (titles can repeat). */
export function exitButtonLabel(p: ExitPot): string {
  const t = p.title.trim() || "Group";
  const title = t.length > MAX_TITLE ? `${t.slice(0, MAX_TITLE - 1)}…` : t;
  return `Exit ${title} (${p.address.slice(0, 6)}…${p.address.slice(-4)})`;
}

/**
 * The reply for /exit in the private chat. `makeLink` is called once per button, so every pot gets its
 * own one-time link. No keyboard when the member is in no pot.
 */
export function exitMenu(pots: ExitPot[], makeLink: (pot: string) => string): { text: string; keyboard: InlineKeyboard | null } {
  const seen = new Set<string>();
  const unique = pots.filter((p) => {
    const k = p.address.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (unique.length === 0) return { text: NO_POTS_TEXT, keyboard: null };

  const kb = new InlineKeyboard();
  if (unique.length === 1) {
    kb.url("Exit with my share", makeLink(unique[0]!.address));
    assertNoMiniApp(kb);
    return { text: `${unique[0]!.title.trim() || "Your group account"}\n\n${EXIT_TEXT}`, keyboard: kb };
  }

  const sorted = [...unique].sort((a, b) => a.title.localeCompare(b.title) || a.address.localeCompare(b.address));
  const shown = sorted.slice(0, MAX_EXIT_BUTTONS);
  shown.forEach((p, i) => {
    if (i > 0) kb.row(); // one pot per row, with no empty row at the end
    kb.url(exitButtonLabel(p), makeLink(p.address));
  });
  assertNoMiniApp(kb);
  const more = sorted.length - shown.length;
  return { text: more > 0 ? `${EXIT_PICK_TEXT}\n\nShowing ${shown.length} of ${sorted.length}.` : EXIT_PICK_TEXT, keyboard: kb };
}
