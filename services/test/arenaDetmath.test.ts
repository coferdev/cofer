import { describe, expect, test } from "bun:test";
import vectors from "./fixtures/detmath-float64.json";
import {
  WAD, erfcWad, expWad, isqrt, lnWad, mulDivDown, mulDivUp, parseWad, phiWad, sqrtWad,
} from "../src/arena/engine/detmath";

// Reference values come from Python's float64 math library (math.log, math.exp, math.erfc, math.sqrt).
// Pass rule: |got - ref| <= 1e-9 * |ref| + 2 wei (a WAD result cannot be closer than its last unit).
function close(got: bigint, ref: string, label: string) {
  const r = Number(ref);
  const g = Number(got) / 1e18;
  const tol = 1e-9 * Math.abs(r) + 2e-18;
  if (!(Math.abs(g - r) <= tol)) throw new Error(`${label}: got ${g}, want ${r}`);
}

describe("detmath against float64", () => {
  test("ln", () => { for (const [x, r] of vectors.ln) close(lnWad(parseWad(x!)), r!, `ln(${x})`); });
  test("exp", () => { for (const [x, r] of vectors.exp) close(expWad(parseWad(x!)), r!, `exp(${x})`); });
  test("erfc", () => { for (const [x, r] of vectors.erfc) close(erfcWad(parseWad(x!)), r!, `erfc(${x})`); });
  test("Phi", () => { for (const [x, r] of vectors.phi) close(phiWad(parseWad(x!)), r!, `Phi(${x})`); });
  test("sqrt", () => { for (const [x, r] of vectors.sqrt) close(sqrtWad(parseWad(x!)), r!, `sqrt(${x})`); });
});

describe("detmath exact properties", () => {
  test("isqrt is the integer floor", () => {
    for (const n of [0n, 1n, 2n, 3n, 4n, 15n, 16n, 17n, 10n ** 36n, 10n ** 36n - 1n, 2n ** 255n]) {
      const r = isqrt(n);
      expect(r * r <= n).toBe(true);
      expect((r + 1n) * (r + 1n) > n).toBe(true);
    }
  });
  test("ln(1) = 0, exp(0) = 1, Phi(0) = 1/2, ln(exp(x)) round trip", () => {
    expect(lnWad(WAD)).toBe(0n);
    expect(expWad(0n)).toBe(WAD);
    expect(phiWad(0n)).toBe(WAD / 2n);
    for (const x of ["0.5", "3", "-2.25"]) {
      const v = parseWad(x);
      const back = lnWad(expWad(v));
      expect(back - v < 10n && v - back < 10n).toBe(true);
    }
  });
  test("Phi is monotonic and symmetric to the last few wei", () => {
    let prev = -1n;
    for (let i = -800; i <= 800; i += 7) {
      const x = (BigInt(i) * WAD) / 100n;
      const p = phiWad(x);
      expect(p >= prev).toBe(true);
      prev = p;
      const s = p + phiWad(-x) - WAD;
      expect(s <= 2n && s >= -2n).toBe(true);
    }
  });
  test("rounding helpers go the stated way", () => {
    expect(mulDivDown(7n, 1n, 2n)).toBe(3n);
    expect(mulDivUp(7n, 1n, 2n)).toBe(4n);
    expect(mulDivDown(-7n, 1n, 2n)).toBe(-4n);
    expect(mulDivUp(-7n, 1n, 2n)).toBe(-3n);
  });
  test("same bits every run (no floats inside)", () => {
    const a = [lnWad(parseWad("123.456")), expWad(parseWad("-3.3")), phiWad(parseWad("1.2345"))];
    const b = [lnWad(parseWad("123.456")), expWad(parseWad("-3.3")), phiWad(parseWad("1.2345"))];
    expect(a).toEqual(b);
  });
  test("refuses bad input", () => {
    expect(() => lnWad(0n)).toThrow();
    expect(() => isqrt(-1n)).toThrow();
    expect(() => parseWad("1e5")).toThrow();
  });
});
