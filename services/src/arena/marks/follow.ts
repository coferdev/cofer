/**
 * Follows the live tape the marks process writes (marks/main.ts): tape-<hour>.ndjson, one JSON line per event, the
 * hour gzipped to tape-<hour>.ndjson.gz when it closes. Reads only whole new lines from where it stopped, carries on
 * across the hour change (finishing a closed hour from its .gz), and hands every tick to `onTick` in order.
 * Read-only: it never writes to the tape directory.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Hex } from "viem";
import type { Mark } from "./median";
import { HOUR_MS, KIND_TICK, decodeEvent, hourOf } from "./tape";

export type OnTick = (tsMs: number, marks: Map<string, Mark>) => void;

export class TapeFollower {
  private hour: number;
  private offset = 0; // bytes of the current hour's ndjson already read
  private rest = ""; // a partial last line, kept until it is complete
  lastTs = 0;

  /** `fromNow`: skip what the current hour's file already holds (a game only needs ticks from its start on). */
  constructor(private readonly dir: string, private readonly onTick: OnTick, startMs = Date.now(), fromNow = false) {
    this.hour = hourOf(startMs);
    const f = this.raw(this.hour);
    if (fromNow && existsSync(f)) {
      this.offset = statSync(f).size;
      this.skipPartial = this.offset > 0 && !this.endsWithNewline(f, this.offset);
    }
  }
  private skipPartial = false;

  private endsWithNewline(f: string, size: number): boolean {
    const fd = openSync(f, "r");
    try {
      const b = Buffer.alloc(1);
      readSync(fd, b, 0, 1, size - 1);
      return b[0] === 0x0a;
    } finally {
      closeSync(fd);
    }
  }

  /** Reads what is new; returns the number of ticks handed on. Call it every few hundred ms. */
  poll(nowMs = Date.now()): number {
    let n = this.readCurrent();
    // the hour closed: finish it (its raw file may already be gzipped) and move on
    while (hourOf(nowMs) > this.hour && this.closed(this.hour)) {
      n += this.finishFromGz();
      this.hour++;
      this.offset = 0;
      this.rest = "";
      n += this.readCurrent();
    }
    return n;
  }

  private raw = (h: number) => join(this.dir, `tape-${h}.ndjson`);
  private closed = (h: number) => existsSync(join(this.dir, `tape-${h}.head`)) || existsSync(`${this.raw(h)}.gz`) || existsSync(this.raw(h + 1));

  private readCurrent(): number {
    const f = this.raw(this.hour);
    if (!existsSync(f)) return 0;
    const size = statSync(f).size;
    if (size <= this.offset) return 0;
    const fd = openSync(f, "r");
    try {
      const buf = Buffer.alloc(size - this.offset);
      readSync(fd, buf, 0, buf.length, this.offset);
      this.offset = size;
      return this.take(buf.toString("utf8"));
    } finally {
      closeSync(fd);
    }
  }

  private finishFromGz(): number {
    const raw = this.raw(this.hour);
    if (existsSync(raw)) return this.readCurrent() + this.take("\n");
    const gz = `${raw}.gz`;
    if (!existsSync(gz)) return this.take("\n");
    const all = Buffer.from(Bun.gunzipSync(new Uint8Array(readFileSync(gz))));
    const tail = all.subarray(this.offset).toString("utf8");
    this.offset = all.length;
    return this.take(tail) + this.take("\n");
  }

  private take(text: string): number {
    if (this.skipPartial) {
      const nl = text.indexOf("\n");
      if (nl < 0) return 0; // still inside the line we joined in the middle of
      text = text.slice(nl + 1);
      this.skipPartial = false;
    }
    const parts = (this.rest + text).split("\n");
    this.rest = parts.pop() ?? "";
    let n = 0;
    for (const line of parts) {
      if (!line.trim()) continue;
      const { kind, encoded } = JSON.parse(line) as { kind: number; encoded: Hex };
      if (kind !== KIND_TICK) continue;
      const ev = decodeEvent(encoded);
      if (ev.kind !== KIND_TICK || ev.tick.tsMs <= this.lastTs) continue;
      this.lastTs = ev.tick.tsMs;
      this.onTick(ev.tick.tsMs, new Map(ev.tick.marks.map((m) => [m.symbol as string, m])));
      n++;
    }
    return n;
  }
}

export { HOUR_MS };
