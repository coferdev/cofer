/**
 * Opening the signer page for an action button. The dashboard never signs: it asks the server for
 * the same one-time signer link the bot makes and opens it in a new tab, where the member reviews
 * and signs with their passkey. The tab is opened on the click itself (a tab opened after waiting
 * for the server is often blocked), then sent to the link; if anything fails it is closed again.
 */

export type OpenResult = { ok: true } | { ok: false; message: string; url?: string };

type Win = { open(url?: string, target?: string): { opener: unknown; location: { href: string }; close(): void } | null };

/** Only a plain web address is ever opened (never javascript: or data:). */
export function isSafeLink(url: string): boolean {
  return /^https:\/\/[^\s/?#]+\/s\/[A-Za-z0-9_.-]+$/.test(url) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/s\/[A-Za-z0-9_.-]+$/.test(url);
}

export async function openSignerTab(getUrl: () => Promise<string>, win: Win = window as unknown as Win): Promise<OpenResult> {
  const tab = win.open('', '_blank');
  if (tab) {
    try {
      tab.opener = null; // the signer page cannot reach back into the dashboard
    } catch {
      /* some browsers do not allow it; the link is a normal page either way */
    }
  }
  let url: string;
  try {
    url = await getUrl();
  } catch (e) {
    tab?.close();
    return { ok: false, message: e instanceof Error ? e.message : 'Could not open the signer page. Try again.' };
  }
  if (!isSafeLink(url)) {
    tab?.close();
    return { ok: false, message: 'Could not open the signer page. Try again.' };
  }
  if (!tab) return { ok: false, message: 'Your browser blocked the new tab. Use this link instead (it works once):', url };
  tab.location.href = url;
  return { ok: true };
}
