#!/usr/bin/env bun
/**
 * CI gate: fails if banned marketing words appear anywhere in the repo.
 * Studio rules: no return-projection language, no endorsement language about third parties.
 * Words are assembled from fragments so this file does not flag itself.
 *
 *   bun tools/banned-words.ts [root]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const f = (...p: string[]) => p.join("");
export const BANNED: { word: string; re: RegExp }[] = [
  { word: f("a", "py"), re: new RegExp(`\\b${f("a", "py")}\\b`, "i") },
  { word: f("yi", "eld"), re: new RegExp(`\\b${f("yi", "eld")}(s|ed|ing)?\\b`, "i") },
  { word: f("guaranteed ", "returns"), re: new RegExp(`${f("guaran", "teed")}\\s+${f("retu", "rn")}s?`, "i") },
  { word: f("part", "ner"), re: new RegExp(`\\b${f("part", "ner")}(s|ship|ships|ed|ing)?\\b`, "i") },
];

const SKIP_DIRS = new Set(["node_modules", ".git", "out", "cache", "artifacts", "dist", "broadcast"]);
const EXT = /\.(ts|tsx|js|mjs|sol|md|json|toml|ya?ml|sql|html|txt)$|\.env\.example$/;

export interface Hit {
  file: string;
  line: number;
  word: string;
  text: string;
}

export function scan(root: string): Hit[] {
  const hits: Hit[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(p);
        continue;
      }
      if (!EXT.test(name) || name === "bun.lock" || name === "package-lock.json") continue;
      const lines = readFileSync(p, "utf8").split("\n");
      lines.forEach((text, i) => {
        for (const b of BANNED) if (b.re.test(text)) hits.push({ file: relative(root, p), line: i + 1, word: b.word, text: text.trim().slice(0, 120) });
      });
    }
  };
  walk(root);
  return hits;
}

if (import.meta.main) {
  const root = process.argv[2] ?? new URL("..", import.meta.url).pathname;
  const hits = scan(root);
  for (const h of hits) console.error(`${h.file}:${h.line}  [${h.word}]  ${h.text}`);
  if (hits.length) {
    console.error(`banned-words: ${hits.length} hit(s)`);
    process.exit(1);
  }
  console.log("banned-words: clean");
}
