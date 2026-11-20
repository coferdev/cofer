/**
 * The App's server (spec §6, §10): the App's static files at /app/, its API at /arena/api/<procedure> (JSON in, JSON
 * out, bigint as decimal strings) and its live connection at /arena/ws (rooms as in §10.2). One process, its own
 * systemd unit, behind the web server on the passkey host. Group accounts never pass through here.
 *
 * Sign-in: a one-time bot link (session.exchange) sets an HttpOnly, Secure, SameSite=Strict cookie for 12 h.
 * Every request that uses the cookie must come from the App's own origin.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import type { Hex } from "viem";
import { MARKETS } from "../marks/markets";
import { type AppSession, readCookie, sessionCookie, signSession, verifyAppLink, verifySession, SESSION_COOKIE } from "./links";
import type { PracticeHub } from "./practiceHub";
import { wire } from "./seatView";

export interface AppServerDeps {
  hub: PracticeHub | null; // null when Practice is switched off
  secret: string;
  /** The App's own origin, e.g. https://test.getcofer.com. Requests with another Origin are refused. */
  origin: string;
  /** Marks a link's jti used; false when it was used before. */
  useJti: (jti: string, tg: number, exp: number) => Promise<boolean>;
  appDist: string | null; // the built App (app/dist), served at /app/
  build: string; // the App build hash shown at /arena/status
  chainId: number;
}

interface WsData {
  s: AppSession;
  rooms: Set<string>;
  msgs: number[];
}

export const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "font-src 'self'",
  "connect-src 'self'", "manifest-src 'self'", "worker-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'", "object-src 'none'",
].join("; ");

const TYPES: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json", ".woff2": "font/woff2", ".ico": "image/x-icon", ".txt": "text/plain" };
const ROOM = /^(sym:[A-Z]{2,6}|t:0x[0-9a-fA-F]{40}(:0x[0-9a-f]{40})?)$/;
const MAX_MSGS_PER_SEC = 10;

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(wire(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
const err = (status: number, error: string) => json({ error }, status);

export function makeAppServer(d: AppServerDeps) {
  const session = (req: Request) => {
    const t = readCookie(req.headers.get("cookie"));
    return t ? verifySession(t, d.secret) : null;
  };
  const sameOrigin = (req: Request) => req.headers.get("origin") === d.origin;

  /** Can this session listen to this room? Marks are public; a table room only for the player's own game and seat. */
  const mayJoin = (s: AppSession, room: string): boolean => {
    if (!ROOM.test(room)) return false;
    if (room.startsWith("sym:")) return Object.prototype.hasOwnProperty.call(MARKETS, room.slice(4));
    const [, table, seat] = room.split(":");
    const game = d.hub?.list(s.tg).find((g) => g.table.toLowerCase() === table!.toLowerCase());
    if (!game) return false;
    if (seat === undefined) return true;
    return d.hub!.get(s.tg, game.id)?.seat === seat;
  };

  async function api(proc: string, req: Request): Promise<Response> {
    if (req.method !== "POST") return err(405, "POST only");
    if (!sameOrigin(req)) return err(403, "wrong origin");
    let input: Record<string, unknown> = {};
    try {
      const text = await req.text();
      if (text.length > 4096) return err(413, "too large");
      input = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error();
    } catch {
      return err(400, "bad input");
    }

    if (proc === "session.exchange") {
      let link;
      try {
        link = verifyAppLink(String(input.token ?? ""), d.secret);
      } catch (e) {
        return err(401, e instanceof Error && e.message === "expired" ? "This link has expired. Ask the bot for a new one." : "This link is not valid. Ask the bot for a new one.");
      }
      if (!(await d.useJti(link.jti, link.tg, link.exp))) return err(401, "This link was already used. Ask the bot for a new one.");
      const token = signSession({ tg: link.tg, addr: link.addr }, d.secret);
      return json({ tgId: link.tg, address: link.addr || null, kind: link.p, ref: link.ref }, 200, { "set-cookie": sessionCookie(token) });
    }

    const s = session(req);
    if (proc === "session.logout") return json({ ok: true }, 200, { "set-cookie": `${SESSION_COOKIE}=; Path=/arena; Max-Age=0; HttpOnly; Secure; SameSite=Strict` });
    if (!s) return err(401, "Not signed in. Open the App from the bot.");
    if (proc === "session.me") return json({ tgId: s.tg, address: s.addr || null, expires: s.exp, practice: d.hub !== null, chainId: d.chainId });

    if (proc === "arena.lobby.list") {
      const tab = input.tab;
      if (tab === "practice") return json(d.hub ? d.hub.list(s.tg) : []);
      if (tab === "mine" || tab === "group" || tab === "freeroll") return json([]); // Friend Tables and Freerolls come with Create/Join
      return err(400, "unknown tab");
    }
    if (!d.hub) return err(404, "Practice is switched off here");
    if (proc === "arena.practice.start") {
      if (!d.hub.tapeLive()) return err(503, "Prices are not coming in right now. Try again in a minute.");
      const r = d.hub.start({ tg: s.tg, pubkey: String(input.pubkey ?? "") as Hex, bots: Number(input.bots ?? 3), minutes: Number(input.minutes ?? 15) });
      if (!r.ok) {
        const why = { KEY: "The game key from this device is not valid.", BUSY: "You already have a Practice game running.", FULL: "Practice is full right now. Try again in a few minutes.", LENGTH: "Practice games run 15, 30 or 60 minutes.", BOTS: "Pick 1 to 9 practice bots." }[r.error];
        return json({ error: why, code: r.error }, r.error === "BUSY" ? 409 : 400);
      }
      return json(r);
    }
    if (proc === "arena.practice.get") {
      const g = d.hub.get(s.tg, String(input.id ?? ""));
      return g ? json(g) : err(404, "No such game");
    }
    return err(404, "unknown procedure");
  }

  function staticFile(path: string): Response {
    if (!d.appDist) return new Response("not found", { status: 404 });
    const rel = path.replace(/^\/app\/?/, "") || "index.html";
    const file = normalize(join(d.appDist, rel));
    const inside = file.startsWith(normalize(d.appDist) + "/");
    const target = inside && existsSync(file) && statSync(file).isFile() ? file : join(d.appDist, "index.html");
    const immutable = target.includes("/assets/") && target !== join(d.appDist, "index.html");
    return new Response(readFileSync(target), {
      headers: {
        "content-type": TYPES[extname(target)] ?? "application/octet-stream",
        "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
        "content-security-policy": CSP, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY",
      },
    });
  }

  return {
    async fetch(req: Request, server: Server<WsData>): Promise<Response | undefined> {
      const url = new URL(req.url);
      const p = url.pathname;
      if (p === "/arena/ws") {
        if (!sameOrigin(req)) return err(403, "wrong origin");
        const s = session(req);
        if (!s) return err(401, "Not signed in");
        return server.upgrade(req, { data: { s, rooms: new Set(), msgs: [] } satisfies WsData }) ? undefined : err(400, "not a websocket");
      }
      if (p.startsWith("/arena/api/")) return api(p.slice("/arena/api/".length), req);
      if (p === "/arena/status") return json({ ok: true, chainId: d.chainId, build: d.build, practice: d.hub !== null, tapeLive: d.hub?.tapeLive() ?? false });
      if (p.startsWith("/arena/log/")) {
        const s = session(req);
        const f = s && d.hub?.files(s.tg, p.slice("/arena/log/".length));
        if (!f) return err(404, "No such log");
        return new Response(readFileSync(f.log), { headers: { "content-type": "text/plain", "content-disposition": `attachment; filename="${f.log.split("/").pop()}"` } });
      }
      if (p === "/app" || p.startsWith("/app/")) return staticFile(p);
      return new Response("not found", { status: 404 });
    },
    websocket: {
      idleTimeout: 120,
      maxPayloadLength: 8 * 1024,
      open(_ws: ServerWebSocket<WsData>) {},
      message(ws: ServerWebSocket<WsData>, raw: string | Buffer) {
        const now = Date.now();
        ws.data.msgs = ws.data.msgs.filter((t) => t > now - 1000);
        if (ws.data.msgs.length >= MAX_MSGS_PER_SEC) return ws.close(1008, "too many messages");
        ws.data.msgs.push(now);
        let m: { op?: unknown; n?: unknown; rooms?: unknown; game?: unknown; bytes?: unknown; sig?: unknown };
        try {
          m = JSON.parse(String(raw));
        } catch {
          return;
        }
        const n = typeof m.n === "number" ? m.n : 0;
        if (m.op === "sub" && Array.isArray(m.rooms)) {
          const ok: string[] = [];
          for (const r of m.rooms.slice(0, 20)) {
            if (typeof r !== "string" || !mayJoin(ws.data.s, r)) continue;
            ws.subscribe(r);
            ws.data.rooms.add(r);
            ok.push(r);
          }
          return void ws.send(wire({ op: "subbed", n, rooms: ok }));
        }
        if (m.op === "order.place") {
          if (!d.hub) return void ws.send(wire({ op: "err", n, error: "OFF" }));
          if (typeof m.game !== "string" || typeof m.bytes !== "string" || typeof m.sig !== "string" || !/^0x[0-9a-f]*$/i.test(m.bytes) || !/^0x[0-9a-f]{128}$/i.test(m.sig)) return void ws.send(wire({ op: "err", n, error: "BAD_ORDER" }));
          const r = d.hub.place(ws.data.s.tg, m.game, m.bytes as Hex, m.sig as Hex);
          return void ws.send(wire(r.ok ? { op: "ack", n, ref: r.ref, recvTs: r.recvTs } : { op: "err", n, error: r.error }));
        }
      },
    },
  };
}
