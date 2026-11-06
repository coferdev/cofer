/**
 * Dashboard sign-in. The bot's private button opens <dashboard>/#t=<one-time link>. The link is read
 * from the URL fragment (never sent to a server by the browser), removed from the address bar at
 * once, and exchanged for a short read-only session. The session is kept for this tab only
 * (sessionStorage), never in localStorage, and is useless after it expires.
 */

const KEY = 'cofer-dashboard-session';

export interface Session {
  session: string;
  expiresAt: string; // ISO
}

/** The one-time link in a fragment like "#t=abc.def", or null. */
export function linkFromHash(hash: string): string | null {
  const t = new URLSearchParams(hash.replace(/^#/, '')).get('t');
  return t && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(t) && t.length <= 2048 ? t : null;
}

export function isLive(s: Session | null, nowMs = Date.now()): s is Session {
  return !!s && Date.parse(s.expiresAt) - nowMs > 5_000;
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function store(): Store | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function loadSession(s: Store | null = store()): Session | null {
  try {
    const v = JSON.parse(s?.getItem(KEY) ?? 'null') as Session | null;
    return v && typeof v.session === 'string' && typeof v.expiresAt === 'string' ? v : null;
  } catch {
    return null;
  }
}

export function saveSession(v: Session, s: Store | null = store()): void {
  try {
    s?.setItem(KEY, JSON.stringify(v));
  } catch {
    /* private mode: the session lives in memory for this page only */
  }
}

export function clearSession(s: Store | null = store()): void {
  try {
    s?.removeItem(KEY);
  } catch {
    /* nothing stored */
  }
}
