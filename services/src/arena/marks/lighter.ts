/**
 * Lighter RH source (spec §4.2): public WS wss://api.rh.lighter.xyz/stream (order book, mid of best bid/ask),
 * falling back to REST GET /api/v1/orderBookDetails (last trade price) while the stream is down or stale.
 * Parsing is pure and tested; the connection code only feeds it.
 */
import { parsePrice, type Symbol } from "./markets";
import type { Quote } from "./median";

export const LIGHTER_WS = "wss://api.rh.lighter.xyz/stream";
export const LIGHTER_REST = "https://api.rh.lighter.xyz/api/v1/orderBookDetails";

/** Lighter RH market_id per symbol (checked against the symbol name in every REST reply). */
export const LIGHTER_MARKET: Record<Symbol, number> = { ETH: 0, BTC: 1, NVDA: 15, TSLA: 16, SPY: 26 };
const BY_ID = new Map(Object.entries(LIGHTER_MARKET).map(([s, id]) => [id, s as Symbol]));

/** REST reply -> one quote per known market (last trade price). Markets whose name does not match are skipped. */
export function parseLighterRest(json: unknown, recvMs: number): Quote[] {
  const list = (json as { order_book_details?: unknown[] })?.order_book_details;
  if (!Array.isArray(list)) return [];
  const out: Quote[] = [];
  for (const m of list as Record<string, unknown>[]) {
    const sym = BY_ID.get(Number(m.market_id));
    if (!sym || m.symbol !== sym) continue;
    const px = parsePrice(m.last_trade_price);
    if (px === null) continue;
    out.push({ source: "lighter", symbol: sym, px, recvMs, srcTs: 0, flags: m.status === "active" ? 0 : 2 });
  }
  return out;
}

type Level = { price: string; size: string };

/** One market's order book, kept from the stream's snapshot and updates. */
export class LighterBook {
  private bids = new Map<string, bigint>();
  private asks = new Map<string, bigint>();
  private offset = -1;
  lastUpdateMs = 0;

  constructor(readonly symbol: Symbol) {}

  /** Apply a snapshot ("subscribed/order_book") or an update ("update/order_book"). Returns false if ignored. */
  apply(msg: { type?: string; offset?: number; timestamp?: number; order_book?: { asks?: Level[]; bids?: Level[]; offset?: number } }): boolean {
    const ob = msg.order_book;
    if (!ob) return false;
    const off = Number(ob.offset ?? msg.offset ?? 0);
    const snapshot = msg.type === "subscribed/order_book";
    if (!snapshot && off <= this.offset) return false;
    if (snapshot) {
      this.bids.clear();
      this.asks.clear();
    }
    for (const [side, levels] of [[this.bids, ob.bids], [this.asks, ob.asks]] as const) {
      for (const l of levels ?? []) {
        const px = parsePrice(l.price);
        if (px === null) continue;
        const size = parsePrice(l.size);
        if (size === null) side.delete(l.price);
        else side.set(l.price, px);
      }
    }
    this.offset = off;
    this.lastUpdateMs = Number(msg.timestamp ?? 0);
    return true;
  }

  /** Floor of the mid of best bid and best ask, or null if a side is empty or the book is crossed. */
  mid(): bigint | null {
    let bb = -1n;
    let ba = -1n;
    for (const p of this.bids.values()) if (p > bb) bb = p;
    for (const p of this.asks.values()) if (ba < 0n || p < ba) ba = p;
    if (bb <= 0n || ba <= 0n || bb >= ba) return null;
    return (bb + ba) / 2n;
  }
}

export interface SourceHandle {
  stop(): void;
}

/**
 * Live Lighter feed. Calls onQuote for every book change (mid), and once a second per symbol from REST while the
 * stream has been quiet for over 2 s. Reconnects with backoff.
 */
export function startLighter(symbols: Symbol[], onQuote: (q: Quote) => void, log: (m: string) => void = () => {}): SourceHandle {
  let stopped = false;
  let ws: WebSocket | null = null;
  let backoff = 1_000;
  const books = new Map<number, LighterBook>();
  const lastWsMs = new Map<Symbol, number>();

  const connect = () => {
    if (stopped) return;
    ws = new WebSocket(LIGHTER_WS);
    ws.onopen = () => {
      backoff = 1_000;
      for (const s of symbols) {
        books.set(LIGHTER_MARKET[s], new LighterBook(s));
        ws!.send(JSON.stringify({ type: "subscribe", channel: `order_book/${LIGHTER_MARKET[s]}` }));
      }
    };
    ws.onmessage = (e) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      const ch = String(msg.channel ?? "");
      const m = /^order_book:(\d+)$/.exec(ch);
      if (!m) return;
      const book = books.get(Number(m[1]));
      if (!book || !book.apply(msg as never)) return;
      const px = book.mid();
      if (px === null) return;
      const now = Date.now();
      lastWsMs.set(book.symbol, now);
      onQuote({ source: "lighter", symbol: book.symbol, px, recvMs: now, srcTs: book.lastUpdateMs, flags: 0 });
    };
    ws.onclose = () => {
      if (stopped) return;
      log(`lighter stream closed; reconnecting in ${backoff} ms`);
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30_000);
    };
    ws.onerror = () => ws?.close();
  };
  connect();

  let busy = false;
  const rest = setInterval(async () => {
    const now = Date.now();
    const quiet = symbols.filter((s) => now - (lastWsMs.get(s) ?? 0) > 2_000);
    if (!quiet.length || busy) return;
    busy = true;
    try {
      const r = await fetch(LIGHTER_REST, { signal: AbortSignal.timeout(2_500) });
      const recv = Date.now();
      for (const q of parseLighterRest(await r.json(), recv)) if (quiet.includes(q.symbol)) onQuote(q);
    } catch (err) {
      log(`lighter rest failed: ${String(err).slice(0, 120)}`);
    } finally {
      busy = false;
    }
  }, 1_000);

  return {
    stop() {
      stopped = true;
      clearInterval(rest);
      ws?.close();
    },
  };
}
