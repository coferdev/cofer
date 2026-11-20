import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Hex, bytesToHex, hexToBytes } from "viem";
import type { Order } from "../src/arena/engine/orders";
import { encodeOrder } from "../src/arena/log/events";
import { TapeFollower } from "../src/arena/marks/follow";
import { LINK_TTL_S, SESSION_TTL_S, readCookie, signAppLink, signSession, verifyAppLink, verifySession } from "../src/arena/app/links";
import { PracticeHub } from "../src/arena/app/practiceHub";
import { CSP, makeAppServer } from "../src/arena/app/server";
import { wire } from "../src/arena/app/seatView";
import { appStartProblem } from "../src/arena/app/main";
import { signLink } from "../src/core/linkToken";
import { verifyPractice } from "../src/arena/replay/verifyPractice";
import { liveTape } from "./arenaTapeFixture";

const CHAIN = 46630;
const SECRET = "s".repeat(40);
const ORIGIN = "https://test.example";
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};

describe("App sign-in links and sessions", () => {
  const now = 1_800_000_000;
  test("a bot link opens once into a 12-hour session; tampering, expiry and other secrets are refused", () => {
    const t = signAppLink({ tg: 42, chat: 0, p: "app", ref: "", addr: "" }, SECRET, now);
    const c = verifyAppLink(t, SECRET, now + 60);
    expect([c.tg, c.p, c.exp]).toEqual([42, "app", now + LINK_TTL_S]);
    expect(() => verifyAppLink(t, "x".repeat(40), now)).toThrow("bad signature");
    expect(() => verifyAppLink(t, SECRET, now + LINK_TTL_S + 1)).toThrow("expired");
    const [body, mac] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ ...c, tg: 43 })).toString("base64url");
    expect(() => verifyAppLink(`${forged}.${mac}`, SECRET, now)).toThrow("bad signature");
    expect(body).toBeTruthy();
    const s = signSession({ tg: 42, addr: "" }, SECRET, now);
    expect(verifySession(s, SECRET, now + SESSION_TTL_S)?.tg).toBe(42);
    expect(verifySession(s, SECRET, now + SESSION_TTL_S + 1)).toBeNull();
    // a session is not a link and a link is not a session
    expect(verifySession(t, SECRET, now)).toBeNull();
    expect(() => verifyAppLink(s, SECRET, now)).toThrow();
    expect(readCookie("a=1; cofer_arena=abc.def; b=2")).toBe("abc.def");
  });

  test("a group signer link is never accepted by the App, even with the same secret", () => {
    const group = signLink({ tg: 42, chat: -5, p: "sign", ref: "", exp: now + 600, jti: "j" }, SECRET);
    expect(() => verifyAppLink(group, SECRET, now)).toThrow();
  });

  test("the App server does not start with the app feature off (mainnet by default)", () => {
    expect(appStartProblem({ CHAIN_ID: "4663", ARENA_FEATURES: "app,practice" })).toContain("off");
    expect(appStartProblem({ CHAIN_ID: "46630", ARENA_FEATURES: "practice" })).toContain("off");
    expect(appStartProblem({ CHAIN_ID: "46630", ARENA_FEATURES: "app" })).toBeNull();
  });
});

/** A seat key made the way the App makes it: WebCrypto P-256, private part not extractable. */
async function browserKey() {
  const k = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"])) as CryptoKeyPair;
  const pub = bytesToHex(new Uint8Array(await crypto.subtle.exportKey("raw", k.publicKey)));
  const sign = async (bytes: Hex) => bytesToHex(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, k.privateKey, new Uint8Array(hexToBytes(bytes)))));
  return { pub, sign };
}

describe("App server: sign in, start Practice, trade over the live connection, result", async () => {
  const start = Date.parse("2026-11-21T09:00:00Z");
  let clock = start;
  const tape = liveTape(start, CHAIN, dirs);
  const out = tmp("arena-app-out-");
  let publish: (room: string, msg: string) => void = () => {};
  const hub = new PracticeHub({ chainId: CHAIN, outDir: out, tapeDir: tape.dir, send: (room, ev, data) => publish(room, wire({ op: "ev", room, ev, data })), now: () => clock });
  const used = new Set<string>();
  const app = makeAppServer({ hub, secret: SECRET, origin: ORIGIN, appDist: null, build: "test", chainId: CHAIN, useJti: async (j) => (used.has(j) ? false : (used.add(j), true)) });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch, websocket: app.websocket });
  publish = (room, msg) => void server.publish(room, msg);
  afterAll(() => server.stop(true));
  const base = `http://127.0.0.1:${server.port}`;
  const post = (proc: string, body: unknown, cookie = "", origin = ORIGIN) =>
    fetch(`${base}/arena/api/${proc}`, { method: "POST", headers: { origin, cookie, "content-type": "application/json" }, body: JSON.stringify(body) });

  const follower = new TapeFollower(tape.dir, (ts, marks) => {
    clock = ts + 40;
    hub.tick(ts, marks);
  }, start);
  const advance = (sec: number) => {
    tape.write(sec);
    follower.poll(start + tape.seconds() * 1000 + 1500);
  };

  const link = signAppLink({ tg: 7, chat: 0, p: "app", ref: "", addr: "" }, SECRET);
  const r1 = await post("session.exchange", { token: link });
  const cookie = (r1.headers.get("set-cookie") ?? "").split(";")[0]!;

  test("session.exchange sets a Secure, HttpOnly, SameSite=Strict cookie; the link works once; another origin is refused", async () => {
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ tgId: 7, address: null, kind: "app", ref: "" });
    expect(r1.headers.get("set-cookie")).toContain("HttpOnly; Secure; SameSite=Strict");
    expect((await post("session.exchange", { token: link })).status).toBe(401);
    expect((await post("session.me", {}, cookie, "https://evil.example")).status).toBe(403);
    expect((await post("session.me", {})).status).toBe(401);
    expect(await (await post("session.me", {}, cookie)).json()).toMatchObject({ tgId: 7, practice: true, chainId: CHAIN });
  });

  const key = await browserKey();
  let game: { id: string; table: Hex; seat: Hex; startAt: number; endAt: number };

  test("Practice will not start on a stopped tape; with live prices it starts a 15-minute game with 3 bots", async () => {
    expect((await post("arena.practice.start", { pubkey: key.pub }, cookie)).status).toBe(503);
    advance(3);
    const r = await post("arena.practice.start", { pubkey: key.pub }, cookie);
    expect(r.status).toBe(200);
    game = (await r.json()) as typeof game;
    expect(game.endAt - game.startAt).toBe(15 * 60_000);
    expect((await post("arena.practice.start", { pubkey: key.pub }, cookie)).status).toBe(409); // one live game each
    expect((await post("arena.practice.start", { pubkey: "0x04" }, signSessionCookie(8))).status).toBe(400);
    const list = (await (await post("arena.lobby.list", { tab: "practice" }, cookie)).json()) as { id: string }[];
    expect(list.map((g) => g.id)).toEqual([game.id]);
    const g = (await (await post("arena.practice.get", { id: game.id }, cookie)).json()) as { seats: { name: string }[]; leverageCap: Record<string, number> };
    expect(g.seats.map((s) => s.name)).toEqual(["You", "Bot 1", "Bot 2", "Bot 3"]);
    expect(g.leverageCap).toMatchObject({ BTC: 20, NVDA: 10 });
    expect((await post("arena.practice.get", { id: game.id }, signSessionCookie(8))).status).toBe(404); // not someone else's
  });

  test("over /arena/ws: rooms are checked, a WebCrypto-signed order is acked, filled at a later tick, and shows in `me`", async () => {
    const msgs: { op: string; ev?: string; room?: string; data?: any; n?: number; rooms?: string[]; ref?: string; error?: string }[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/arena/ws`, { headers: { cookie, origin: ORIGIN } } as never);
    ws.onmessage = (e) => msgs.push(JSON.parse(String(e.data)));
    await new Promise((r) => (ws.onopen = r));
    const wait = async (f: () => boolean) => {
      for (let i = 0; i < 100 && !f(); i++) await Bun.sleep(10);
      expect(f()).toBe(true);
    };
    const seatRoom = `t:${game.table}:${game.seat.toLowerCase()}`;
    ws.send(JSON.stringify({ op: "sub", n: 1, rooms: ["sym:BTC", `t:${game.table}`, seatRoom, `t:${game.table}:0x${"1".repeat(40)}`, "sym:DOGE", "anything"] }));
    await wait(() => msgs.some((m) => m.op === "subbed"));
    expect(msgs.find((m) => m.op === "subbed")!.rooms).toEqual(["sym:BTC", `t:${game.table}`, seatRoom]);

    advance(5); // the game has started
    await wait(() => msgs.some((m) => m.ev === "board") && msgs.some((m) => m.ev === "mark"));
    const mark = msgs.find((m) => m.ev === "mark")!.data;
    expect(mark).toMatchObject({ s: "BTC", status: "OK", src: [1, 1, 0] });
    expect(typeof mark.px).toBe("string"); // bigint as decimal strings

    const order: Order = { seat: game.seat.toLowerCase(), nonce: 1n, kind: "MARKET", symbol: "BTC", product: "PERP", side: "BUY", pctFreeBps: 2_000n, leverage: 5n, clientId: "app-1" };
    const bytes = encodeOrder(game.table, order);
    ws.send(JSON.stringify({ op: "order.place", n: 2, game: game.id, bytes, sig: await key.sign(bytes) }));
    await wait(() => msgs.some((m) => m.n === 2 && m.op !== "subbed"));
    expect(msgs.find((m) => m.n === 2)).toMatchObject({ op: "ack", ref: "app-1" });
    // a signature from another key is refused and never logged
    const other = await browserKey();
    const b2 = encodeOrder(game.table, { ...order, nonce: 2n, clientId: "app-2" });
    ws.send(JSON.stringify({ op: "order.place", n: 3, game: game.id, bytes: b2, sig: await other.sign(b2) }));
    await wait(() => msgs.some((m) => m.n === 3));
    expect(msgs.find((m) => m.n === 3)).toMatchObject({ op: "err", error: "SIGNATURE" });

    advance(3);
    await wait(() => msgs.some((m) => m.ev === "fill"));
    expect(msgs.find((m) => m.ev === "fill")!.data).toMatchObject({ ref: "app-1" });
    const me = msgs.filter((m) => m.ev === "me").at(-1)!.data;
    expect(me.positions[0]).toMatchObject({ symbol: "BTC", product: "PERP", lev: "5" });
    expect(me.positions[0].holdUntil).toBeGreaterThan(clock); // the 60 s minimum hold shows
    expect(me.warn).toBe(false);
    ws.close();
  });

  test("the game ends on time with a result; its log checks PASS from the log and the tape alone", async () => {
    advance(15 * 60 + 5);
    const g = (await (await post("arena.practice.get", { id: game.id }, cookie)).json()) as { result: { head: Hex; standings: { name: string; rank: number }[] } };
    expect(g.result.standings.map((s) => s.rank)).toEqual([1, 2, 3, 4]);
    expect(g.result.standings.map((s) => s.name).sort()).toEqual(["Bot 1", "Bot 2", "Bot 3", "You"]);
    const log = await (await fetch(`${base}/arena/log/${game.id}`, { headers: { cookie } })).text();
    expect((await fetch(`${base}/arena/log/${game.id}`)).status).toBe(404);
    const entries = log.trim().split("\n") as Hex[];
    const hours = new Map<number, Hex[]>();
    const heads = new Map<number, Hex>();
    const fs = await import("node:fs");
    for (const f of fs.readdirSync(tape.dir)) {
      const m = /^tape-(\d+)\.(ndjson(\.gz)?|head)$/.exec(f);
      if (!m) continue;
      const h = Number(m[1]);
      const raw = fs.readFileSync(join(tape.dir, f));
      if (m[2] === "head") heads.set(h, raw.toString().trim() as Hex);
      else hours.set(h, new TextDecoder().decode(m[3] ? Bun.gunzipSync(new Uint8Array(raw)) : raw).split("\n").filter(Boolean).map((l) => JSON.parse(l).encoded as Hex));
    }
    const c = verifyPractice(CHAIN, entries, hours, heads, g.result.head);
    expect(c.steps.map((s) => s.status)).toEqual(["PASS", "PASS", "PASS"]);
    expect((await post("arena.practice.start", { pubkey: key.pub }, cookie)).status).toBe(200); // free to start another
  });

  test("security headers on the App's files", () => {
    expect(CSP).toContain("frame-ancestors 'none'");
    expect(CSP).toContain("connect-src 'self'");
    expect(CSP).not.toContain("unsafe-eval");
  });
});

function signSessionCookie(tg: number) {
  return `cofer_arena=${signSession({ tg, addr: "" }, SECRET)}`;
}
