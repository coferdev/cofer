/**
 * The App's live connection (spec §10.2): /arena/ws on the same origin. Rooms are joined with `sub` and joined again
 * after a reconnect; orders go out as `order.place` and resolve on the server's ack (or its refusal).
 */
type Handler = (ev: string, data: any, room: string) => void;

export class Live {
  private ws: WebSocket | null = null;
  private n = 0;
  private waiting = new Map<number, { ok: (v: any) => void; no: (e: Error) => void }>();
  private closed = false;
  private retry = 500;
  status: 'connecting' | 'open' | 'down' = 'connecting';
  onStatus: (s: Live['status']) => void = () => {};

  constructor(private readonly rooms: string[], private readonly on: Handler) {
    this.connect();
  }

  private connect() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/arena/ws`);
    this.ws = ws;
    this.setStatus('connecting');
    ws.onopen = () => {
      this.retry = 500;
      this.setStatus('open');
      ws.send(JSON.stringify({ op: 'sub', n: ++this.n, rooms: this.rooms }));
    };
    ws.onmessage = (e) => {
      let m: any;
      try {
        m = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (m.op === 'ev') return this.on(m.ev, m.data, m.room);
      const w = this.waiting.get(m.n);
      if (!w) return;
      this.waiting.delete(m.n);
      if (m.op === 'ack') w.ok(m);
      else if (m.op === 'err') w.no(new Error(m.error));
    };
    ws.onclose = () => {
      this.setStatus('down');
      for (const w of this.waiting.values()) w.no(new Error('DISCONNECTED'));
      this.waiting.clear();
      if (this.closed) return;
      setTimeout(() => this.connect(), this.retry);
      this.retry = Math.min(this.retry * 2, 10_000);
    };
  }

  private setStatus(s: Live['status']) {
    this.status = s;
    this.onStatus(s);
  }

  place(game: string, bytes: string, sig: string): Promise<{ ref: string; recvTs: number }> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('DISCONNECTED'));
    const n = ++this.n;
    return new Promise((ok, no) => {
      this.waiting.set(n, { ok, no });
      ws.send(JSON.stringify({ op: 'order.place', n, game, bytes, sig }));
      setTimeout(() => this.waiting.get(n) && (this.waiting.delete(n), no(new Error('TIMEOUT'))), 10_000);
    });
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }
}
