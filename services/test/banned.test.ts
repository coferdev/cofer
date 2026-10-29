import { describe, expect, test } from "bun:test";
import { scan, BANNED } from "../../tools/banned-words";

describe("CI banned words", () => {
  test("the scanner catches each banned word", () => {
    const j = (...p: string[]) => p.join("");
    const samples = [j("high A", "PY here"), j("real yi", "eld"), j("guaranteed  ", "returns"), j("our part", "ners")];
    samples.forEach((s, i) => expect(BANNED[i]!.re.test(s)).toBe(true));
    expect(BANNED.some((b) => b.re.test("party member, happy"))).toBe(false);
  });

  test("the whole repo is clean", () => {
    const hits = scan(new URL("../..", import.meta.url).pathname);
    expect(hits).toEqual([]);
  });
});
