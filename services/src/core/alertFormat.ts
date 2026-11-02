/**
 * The one format for every staff alert (see docs/alerts.md):
 *
 *   [cofer alert] price-stale-TSLA
 *   TSLA price is past its limit (14h old, limit 12h). Deposits and swaps that need it are refused.
 *   Who acts: Dev checks.
 *   https://explorer.example/tx/0x…
 *
 * No full addresses: known ones become role names, tokens their symbol, anything else 0x1234…abcd.
 * Transaction and vote hashes are shortened the same way; a transaction is shown as an explorer
 * link. The only full address allowed is the relayer's in relayer-low (so it can be topped up).
 * Pure.
 */
import { redact } from "./errors";

export const ALERT_PREFIX = "[cofer alert]";

/** Who acts, in the staff group's words. */
export const WHO = {
  dev: "Dev checks.",
  topUp: "Top up the relayer.",
  emergency: "Emergency: tell the owner and the dev at once.",
  none: "No action needed if this change was planned. If it was not, tell the owner and the dev at once.",
} as const;

export interface AlertMessage {
  /** Short name, e.g. "relayer-low", "price-stale-TSLA" (see alertName). */
  name: string;
  /** One plain sentence (or two) on what happened. */
  what: string;
  /** One sentence on who acts (usually a WHO value). */
  who: string;
  emergency?: boolean;
  /** Transaction hash, shown as an explorer link. */
  tx?: string;
  /** The one full address allowed in this message (the relayer, in relayer-low only). */
  keep?: string;
  /**
   * A problem an RPC outage causes anyway (indexer-behind, job-failing, errors-spike): held back
   * while the RPC is failing and for a short grace period after (rpc-down covers it). Never set
   * on an emergency.
   */
  rpcRelated?: boolean;
}

/** Known addresses by role. Unset roles are simply not named. */
export interface Roles {
  owner?: string; // EXPECTED_OWNER
  guardian?: string; // EXPECTED_GUARDIAN
  feeWallet?: string; // EXPECTED_FEE_WALLET (all fee sinks)
  relayer?: string;
  factory?: string;
  feeRouter?: string;
  adapter?: string;
}

const ROLE_NAMES: Record<keyof Roles, string> = {
  owner: "owner Safe",
  guardian: "guardian",
  feeWallet: "fee wallet",
  relayer: "relayer",
  factory: "factory",
  feeRouter: "fee router",
  adapter: "swap adapter",
};

export type AddressBook = ReadonlyMap<string, string>;

/**
 * Lowercase address -> name. Token symbols come last and never replace a role name. If one wallet
 * holds several roles (the guardian is also the fee wallet), the names are joined: "guardian and fee wallet".
 */
export function addressBook(roles: Roles, tokens: Record<string, string> = {}): AddressBook {
  const book = new Map<string, string>();
  for (const k of Object.keys(ROLE_NAMES) as (keyof Roles)[]) {
    const a = roles[k]?.toLowerCase();
    if (!a) continue;
    const had = book.get(a);
    book.set(a, had ? `${had} and ${ROLE_NAMES[k]}` : ROLE_NAMES[k]);
  }
  for (const [a, sym] of Object.entries(tokens)) {
    const key = a.toLowerCase();
    if (!book.has(key)) book.set(key, safeSymbol(sym));
  }
  return book;
}

/** "0x1234…abcd" for an address or a longer hash. */
export function shortHex(hex: string): string {
  return hex.length <= 12 ? hex : `${hex.slice(0, 6)}…${hex.slice(-4)}`;
}

/** The role name or symbol for an address, else its short form. */
export function nameOf(book: AddressBook, address: string): string {
  return book.get(address.toLowerCase()) ?? shortHex(address);
}

/** A token symbol as it may appear in an alert: letters, digits and dots only, at most 12. */
export function safeSymbol(symbol: string): string {
  const s = symbol.replace(/[^A-Za-z0-9.]/g, "").slice(0, 12);
  return s || "token";
}

/** "price-stale" + "TSLA" -> "price-stale-TSLA". */
export function alertName(base: string, symbol?: string): string {
  return symbol === undefined ? base : `${base}-${safeSymbol(symbol)}`;
}

const LONG_HEX = /0x[0-9a-fA-F]{40,}/g;

/**
 * Shortens every address or hash still in the text (a safety net under nameOf). Known addresses
 * get their name. `keep` is the one address left in full (the relayer, in relayer-low only).
 */
export function scrubHex(text: string, book: AddressBook = new Map(), keep?: string): string {
  const k = keep?.toLowerCase();
  return text.replace(LONG_HEX, (m) => {
    if (k && m.toLowerCase() === k) return m;
    return m.length === 42 ? nameOf(book, m) : shortHex(m);
  });
}

/** The explorer link for a transaction, or its short hash when no explorer is set. */
export function txLink(explorer: string | undefined, hash: string): string {
  if (!explorer || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return `Transaction ${shortHex(hash)}.`;
  return `${explorer.replace(/\/+$/, "")}/tx/${hash}`;
}

export interface FormatOptions {
  book?: AddressBook;
  explorer?: string; // EXPLORER_URL
  keep?: string; // the one full address allowed (relayer-low)
}

/**
 * The full message. URLs in the text are removed (they can hold keys); the explorer link is
 * added afterwards, so it is the only link in the message.
 */
export function alertText(m: AlertMessage, o: FormatOptions = {}): string {
  const keep = o.keep ?? m.keep;
  const clean = (s: string) => scrubHex(redact(s), o.book, keep).trim();
  const lines = [`${ALERT_PREFIX} ${m.name}${m.emergency ? " (EMERGENCY)" : ""}`, clean(m.what), `Who acts: ${clean(m.who)}`];
  if (m.tx) lines.push(txLink(o.explorer, m.tx));
  return lines.join("\n");
}

/** The name in a stored alert's first line ("[cofer alert] role-changed (EMERGENCY)" -> "role-changed"), else null. */
export function nameFromText(text: string): string | null {
  const first = text.split("\n")[0]!;
  if (!first.startsWith(`${ALERT_PREFIX} `)) return null;
  return first.slice(ALERT_PREFIX.length + 1).replace(/ \(EMERGENCY\)$/, "").trim() || null;
}

/** True if a stored alert is an emergency. */
export function isEmergencyText(text: string): boolean {
  return text.split("\n")[0]!.endsWith(" (EMERGENCY)");
}

/** "[cofer alert] price-stale-TSLA: Cleared (the feed updated)." */
export function clearedText(name: string, note?: string): string {
  const why = note ? ` (${scrubHex(redact(note)).trim()})` : "";
  return `${ALERT_PREFIX} ${name}: Cleared${why}.`;
}

/** How often an open emergency is posted again (the owner's setting). Other alerts are never repeated. */
export const EMERGENCY_REMIND_EVERY_SEC = 30 * 60;

/** A reminder for an emergency that is still open, from its stored message: "Still open after 45m." after the name line. */
export function reminderText(stored: string, openForSec: number): string {
  const mins = Math.max(0, Math.floor(openForSec / 60));
  const since = mins >= 120 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
  const [first, ...rest] = stored.split("\n");
  return [first, `Still open after ${since}.`, ...rest].join("\n");
}
