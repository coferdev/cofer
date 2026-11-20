/** A tape directory written exactly as the marks process writes it (NDJSON lines; head + gzip when an hour closes). */
import { appendFileSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hex } from "viem";
import type { Quote } from "../src/arena/marks/median";
import { type EncodedEvent, TapeWriter } from "../src/arena/marks/tape";

const PX = (n: number) => BigInt(Math.round(n * 1e8));

export function liveTape(startMs: number, chainId: number, dirs: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "arena-practice-tape-"));
  dirs.push(dir);
  const sink = (e: EncodedEvent) => appendFileSync(join(dir, `tape-${e.hourId}.ndjson`), `${JSON.stringify({ seq: e.seq, kind: e.kind, encoded: e.encoded, chainHash: e.chainHash })}\n`);
  const closed = (h: number, head: Hex) => {
    writeFileSync(join(dir, `tape-${h}.head`), `${head}\n`);
    const raw = join(dir, `tape-${h}.ndjson`);
    writeFileSync(`${raw}.gz`, Bun.gzipSync(readFileSync(raw)));
    unlinkSync(raw);
  };
  const w = new TapeWriter(chainId, sink, closed, undefined, ["BTC", "ETH"]);
  let s = 0;
  /** Writes the next `n` seconds of quotes and ticks. */
  const write = (n: number) => {
    for (let k = 0; k < n; k++, s++) {
      const t0 = startMs + s * 1000;
      const btc = 100_000 + 40 * Math.sin(s / 9) + s * 2;
      const eth = 4_000 - 3 * Math.cos(s / 7) - s / 10;
      const qs: Quote[] = [
        { source: "lighter", symbol: "BTC", px: PX(btc), recvMs: t0 + 100, srcTs: 0, flags: 0 },
        { source: "arcus", symbol: "BTC", px: PX(btc + 1), recvMs: t0 + 120, srcTs: 0, flags: 0 },
        { source: "lighter", symbol: "ETH", px: PX(eth), recvMs: t0 + 110, srcTs: 0, flags: 0 },
        { source: "arcus", symbol: "ETH", px: PX(eth + 0.05), recvMs: t0 + 130, srcTs: 0, flags: 0 },
      ];
      for (const q of qs) w.quote(q);
      w.tick(t0 + 1000);
    }
  };
  return { dir, write, seconds: () => s };
}
