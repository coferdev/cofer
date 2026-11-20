/** The names of every setting the services read (from env.ts), for status reports. Names only: values are never read. */
import { readFileSync } from "node:fs";

export function schemaKeys(): string[] {
  const src = readFileSync(new URL("../../src/env.ts", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("z.object({"), src.indexOf("});", src.indexOf("z.object({")));
  return [...body.matchAll(/^\s{2}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]!);
}
