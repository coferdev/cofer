/**
 * Check one hour of tape from an NDJSON file: hash chain, order, and every tick against the mark rule.
 *   bun src/arena/marks/verify.ts <tape-HOUR.ndjson[.gz]> [--chain 4663] [--head 0x...]
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { Hex } from "viem";
import { verifyTape } from "./tape";

const file = process.argv[2];
if (!file) {
  console.log("usage: verify.ts <tape-HOUR.ndjson> [--chain 4663] [--head 0x...]");
  process.exit(2);
}
const ci = process.argv.indexOf("--chain");
const hi = process.argv.indexOf("--head");
const chainId = ci > 0 ? Number(process.argv[ci + 1]) : 4663;
const head = hi > 0 ? (process.argv[hi + 1] as Hex) : undefined;
const hourId = Number(/tape-(\d+)\.ndjson(\.gz)?$/.exec(basename(file))?.[1]);
const buf = readFileSync(file);
const text = file.endsWith(".gz") ? new TextDecoder().decode(Bun.gunzipSync(buf)) : buf.toString("utf8");
const lines = text.trim().split("\n").map((l) => JSON.parse(l).encoded as Hex);
const r = verifyTape(chainId, hourId, lines, undefined, head);
console.log(`hour ${hourId} (${new Date(hourId * 3_600_000).toISOString().slice(0, 13)}:00 UTC): ${r.quotes} quotes, ${r.ticks} ticks`);
console.log(`tapeHead ${r.tapeHead}`);
for (const p of r.problems.slice(0, 20)) console.log(`  ${p}`);
console.log(r.ok ? "PASS" : `FAIL (${r.problems.length} problems)`);
process.exit(r.ok ? 0 : 1);
