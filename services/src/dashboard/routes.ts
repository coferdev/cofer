/**
 * Read-only dashboard API, served by the api role under /api/dashboard/. The dashboard site calls it
 * on its own address (Caddy forwards these paths), so no CORS is needed and none is allowed.
 *
 * Sign-in: the bot's private "Open dashboard" button carries a one-time "dashboard" link in the URL
 * fragment. The page sends it once to POST /session and gets a short "dash" session back. A link is
 * single-use (atomic in the database), a signer link or session is refused here, and a dashboard
 * link or session is refused by the signer API (api/router.ts).
 *
 * Data: only pots where the caller's own key is an active member. A pot the caller is not in gets
 * exactly the same 404 as a pot that does not exist. No route can move money or create anything.
 */
import { Hono, type Context } from "hono";
import { getAddress, isAddress, type Address } from "viem";
import { newJti, signLink, verifyLink, type LinkClaims } from "../core/linkToken";
import { logError } from "../core/errors";
import { potSummary, potView, type PotViewInput } from "./view";

export const DASHBOARD_LINK_TTL_SEC = 10 * 60; // the button's one-time link
export const DASHBOARD_SESSION_TTL_SEC = 30 * 60; // the session it is exchanged for

export const TEXT = {
  link: "This dashboard link has expired or was already used. Open it again from Telegram: send /me to the bot.",
  session: "Your dashboard session has ended. Open it again from Telegram: send /me to the bot.",
  notFound: "Not found.",
  bad: "Bad request.",
  down: "Couldn't load the data just now. Try again in a minute.",
} as const;

export interface PotListItem {
  address: string;
  title: string;
  members: number;
  totalUsdg: bigint | null;
  partial: boolean;
}

export interface DashboardDeps {
  secret: string;
  chainId: number;
  now?: () => number; // unix seconds
  /** Marks a one-time link used. True only for its first use; must be atomic (two taps at once: one wins). */
  spendLink(l: { jti: string; tg: number; purpose: string; expiresAt: Date }): Promise<boolean>;
  /** The member key bound to this Telegram account, or null if none yet. */
  keyOf(tg: number): Promise<Address | null>;
  /** Pots where `member` is an active member. */
  potsOf(member: Address): Promise<PotListItem[]>;
  /** Everything one pot's view needs, or null when `member` is not an active member of it (or it does not exist). */
  potInput(pot: Address, member: Address, now: number): Promise<PotViewInput | null>;
}

const NO_STORE = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

function json(c: Context, body: unknown, status = 200) {
  return c.json(body as object, status as 200, NO_STORE);
}

/** The dashboard session in the Authorization header, or null. Only a "dash" session counts. */
export function dashSession(header: string | undefined, secret: string, now: number): LinkClaims | null {
  const token = header?.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  try {
    const claims = verifyLink(token, secret, now);
    return claims.p === "dash" ? claims : null;
  } catch {
    return null;
  }
}

export function dashboardRoutes(d: DashboardDeps) {
  const now = d.now ?? (() => Math.floor(Date.now() / 1000));
  const app = new Hono();

  // a failed read (database or chain) is logged without URLs and shown as fixed text
  app.onError((err, c) => {
    logError("dashboard", err);
    return json(c, { error: TEXT.down }, 503);
  });

  app.post("/session", async (c) => {
    let token: unknown;
    try {
      token = ((await c.req.json()) as { token?: unknown })?.token;
    } catch {
      return json(c, { error: TEXT.bad }, 400);
    }
    if (typeof token !== "string" || token.length > 2048) return json(c, { error: TEXT.bad }, 400);
    let claims: LinkClaims;
    try {
      claims = verifyLink(token, d.secret, now());
    } catch {
      return json(c, { error: TEXT.link }, 401);
    }
    // only a dashboard link made for the member's own private chat (chat id = user id)
    if (claims.p !== "dashboard" || claims.chat !== claims.tg) return json(c, { error: TEXT.link }, 401);
    const first = await d.spendLink({ jti: claims.jti, tg: claims.tg, purpose: claims.p, expiresAt: new Date(claims.exp * 1000) });
    if (!first) return json(c, { error: TEXT.link }, 401);
    const exp = now() + DASHBOARD_SESSION_TTL_SEC;
    const session = signLink({ tg: claims.tg, chat: claims.tg, p: "dash", ref: "", exp, jti: newJti() }, d.secret);
    return json(c, { session, expiresAt: new Date(exp * 1000).toISOString() });
  });

  app.get("/pots", async (c) => {
    const s = dashSession(c.req.header("authorization"), d.secret, now());
    if (!s) return json(c, { error: TEXT.session }, 401);
    const key = await d.keyOf(s.tg);
    if (!key) return json(c, { chainId: d.chainId, linked: false, pots: [] });
    const pots = await d.potsOf(key);
    return json(c, { chainId: d.chainId, linked: true, address: key, pots: pots.map(potSummary) });
  });

  app.get("/pots/:pot", async (c) => {
    const s = dashSession(c.req.header("authorization"), d.secret, now());
    if (!s) return json(c, { error: TEXT.session }, 401);
    const raw = c.req.param("pot");
    if (!isAddress(raw, { strict: false })) return json(c, { error: TEXT.notFound }, 404);
    const key = await d.keyOf(s.tg);
    if (!key) return json(c, { error: TEXT.notFound }, 404);
    const t = now();
    const input = await d.potInput(getAddress(raw), key, t);
    if (!input) return json(c, { error: TEXT.notFound }, 404);
    return json(c, potView(input));
  });

  // anything else under this prefix
  app.all("*", (c) => json(c, { error: TEXT.notFound }, 404));
  return app;
}
