/**
 * Only a group admin may open the group's account with /newpot (audit v2 L-2). A group has one pot,
 * so before this any member with a key could open it first and become its only founding member.
 * Checked before anything else in /newpot, so the relayer never pays for a refused one.
 *
 * An admin with "Remain anonymous" on posts as the group: Telegram sends the message from
 * GroupAnonymousBot with `sender_chat` set, so their own role cannot be checked. That is refused with
 * a message saying how to fix it. A message sent on behalf of any chat (a linked channel) is refused
 * the same way: it is not from one person.
 */

/** Telegram's fixed user id for GroupAnonymousBot (the sender of an anonymous admin's messages). */
export const GROUP_ANONYMOUS_BOT_ID = 1087968824;

export const NEWPOT_ADMINS_ONLY_TEXT = "Only a group admin can open the group account. Ask an admin to run /newpot.";
export const NEWPOT_ANONYMOUS_TEXT =
  'You are posting as the group ("Remain anonymous" is on), so I cannot check that you are an admin. Turn off "Remain anonymous" for yourself in the group\'s admin settings, run /newpot again, then turn it back on if you like.';
export const NEWPOT_ROLE_UNKNOWN_TEXT = "I couldn't check your role in this group just now. Nothing was created. Try again in a minute.";

export interface NewpotCaller {
  fromId?: number;
  /** message.sender_chat.id: set when the message was sent on behalf of a chat (anonymous admin, linked channel). */
  senderChatId?: number;
}

/**
 * null when the caller may run /newpot; otherwise the fixed text to reply with.
 * @param role the caller's status in this chat (ctx.getChatMember(fromId).status); a failed lookup refuses
 */
export async function newpotAdminRefusal(caller: NewpotCaller, role: () => Promise<string>): Promise<string | null> {
  if (caller.senderChatId !== undefined || caller.fromId === GROUP_ANONYMOUS_BOT_ID || caller.fromId === undefined) return NEWPOT_ANONYMOUS_TEXT;
  let status: string;
  try {
    status = await role();
  } catch {
    return NEWPOT_ROLE_UNKNOWN_TEXT; // never guess
  }
  return status === "creator" || status === "administrator" ? null : NEWPOT_ADMINS_ONLY_TEXT;
}
