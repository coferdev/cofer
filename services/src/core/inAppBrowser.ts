/**
 * Built-in ("in-app") browsers of chat and social apps cannot use passkeys for our site. The signer
 * page checks this before anything else: no passkey prompt, and the one-time link is not used up,
 * so the same link still works once it is opened in the phone's own browser.
 *
 * Read from the browser's user agent only. Pure (no DOM), so it is unit-tested.
 */

/** App name tokens in the user agent, checked in this order. */
const APPS: readonly (readonly [RegExp, string])[] = [
  [/Telegram/i, "Telegram"],
  [/Instagram/i, "Instagram"],
  [/\bFB_IAB\b|\bFBAN\/|\bFBAV\/|\bFBIOS\b/, "Facebook"],
  [/Messenger/i, "Messenger"],
  [/musical_ly|BytedanceWebview|\bTikTok\b|\btrill\b/i, "TikTok"],
  [/Snapchat/i, "Snapchat"],
  [/LinkedInApp/i, "LinkedIn"],
  [/MicroMessenger/i, "WeChat"],
  [/\bLine\//, "LINE"],
  [/Twitter/i, "X"],
  [/Pinterest/i, "Pinterest"],
  [/Discord/i, "Discord"],
];

/**
 * The app whose built-in browser this is, "" for an app we cannot name, or null for a normal browser.
 *  - a named app token above;
 *  - Android WebView (the "; wv)" token): an app's built-in browser;
 *  - iPhone/iPad WebKit without a "Safari/" token: an app's built-in browser. Safari, Chrome, Firefox,
 *    Edge, Brave and DuckDuckGo on iPhone all carry "Safari/".
 */
export function inAppBrowser(userAgent: string): string | null {
  for (const [re, name] of APPS) if (re.test(userAgent)) return name;
  if (/Android/i.test(userAgent) && /; wv\)/.test(userAgent)) return "";
  if (/iPhone|iPad|iPod/.test(userAgent) && /AppleWebKit/.test(userAgent) && !/Safari\//.test(userAgent)) return "";
  return null;
}

/** What the page shows instead of the passkey button inside an app's built-in browser. */
export function inAppText(app: string): string {
  const where = app ? `inside ${app}` : "inside an app";
  return `Passkeys don't work ${where}. Tap the menu (••• or ⋮) and choose Open in browser (on iPhone: Open in Safari), then use this same link there. Nothing was created or sent, and this link still works.`;
}
