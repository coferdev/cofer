/**
 * Deterministic fixed-point maths for the Arena engine (spec §4.6). Every value is a bigint scaled by 1e18 (WAD).
 * No floats and no Math.* calls, so the engine, the three signers and the public replay tool get the same bits on
 * any JavaScript runtime. Work is done at 1e36 inside and rounded down to 1e18 at the end.
 */

export const WAD = 10n ** 18n;
const HI = 10n ** 36n; // internal scale
const HI_PER_WAD = HI / WAD;

/** ln 2 and 1/sqrt(pi) at 1e36 (exact digits, truncated). */
const LN2_HI = 693147180559945309417232121458176568n;
const INV_SQRT_PI_HI = 564189583547756286948079451560772585n;
const SQRT2_HI = 1414213562373095048801688724209698078n;

export class DetMathError extends Error {}

const abs = (x: bigint) => (x < 0n ? -x : x);

/** floor(a * b / d) for non-negative d; rounds toward minus infinity for negative results. */
export function mulDivDown(a: bigint, b: bigint, d: bigint): bigint {
  if (d <= 0n) throw new DetMathError("division by zero");
  const n = a * b;
  const q = n / d;
  return n < 0n && q * d !== n ? q - 1n : q;
}

/** ceil(a * b / d) for non-negative d. */
export function mulDivUp(a: bigint, b: bigint, d: bigint): bigint {
  if (d <= 0n) throw new DetMathError("division by zero");
  const n = a * b;
  const q = n / d;
  return n > 0n && q * d !== n ? q + 1n : q;
}

export const wmulDown = (a: bigint, b: bigint) => mulDivDown(a, b, WAD);
export const wmulUp = (a: bigint, b: bigint) => mulDivUp(a, b, WAD);
export const wdivDown = (a: bigint, b: bigint) => mulDivDown(a, WAD, b);
export const wdivUp = (a: bigint, b: bigint) => mulDivUp(a, WAD, b);

/** floor(sqrt(n)) for a non-negative integer, by integer Newton iteration. */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new DetMathError("sqrt of a negative number");
  if (n < 2n) return n;
  let x = 1n << BigInt((n.toString(2).length + 1) >> 1);
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/** sqrt(x) for a WAD x, rounded down. */
export function sqrtWad(x: bigint): bigint {
  return isqrt(x * WAD);
}

// ------------------------------------------------------------------ ln (range reduction + atanh series)

function lnHi(xHi: bigint): bigint {
  if (xHi <= 0n) throw new DetMathError("ln of a non-positive number");
  // x = m * 2^k with m in [1, 2)
  let k = 0n;
  let m = xHi;
  while (m >= 2n * HI) {
    m >>= 1n;
    k += 1n;
  }
  while (m < HI) {
    m <<= 1n;
    k -= 1n;
  }
  // bring m into [1/sqrt2, sqrt2) so z = (m-1)/(m+1) stays under 0.172
  if (m > SQRT2_HI) {
    m = m / 2n;
    k += 1n;
  }
  const z = ((m - HI) * HI) / (m + HI);
  const z2 = (z * z) / HI;
  let term = z;
  let sum = 0n;
  for (let n = 1n; term !== 0n; n += 2n) {
    sum += term / n;
    term = (term * z2) / HI;
  }
  return k * LN2_HI + 2n * sum;
}

/** Natural log of a WAD x > 0, as WAD (rounded toward minus infinity). */
export function lnWad(x: bigint): bigint {
  return floorDiv(lnHi(x * HI_PER_WAD), HI_PER_WAD);
}

// ------------------------------------------------------------------ exp (range reduction + Taylor)

function expHi(xHi: bigint): bigint {
  // x = k ln2 + r, |r| <= ln2 / 2
  let k = xHi / LN2_HI;
  let r = xHi - k * LN2_HI;
  if (r > LN2_HI / 2n) {
    r -= LN2_HI;
    k += 1n;
  } else if (r < -LN2_HI / 2n) {
    r += LN2_HI;
    k -= 1n;
  }
  let term = HI;
  let sum = HI;
  for (let n = 1n; term !== 0n; n += 1n) {
    term = (term * r) / HI / n;
    sum += term;
  }
  return k >= 0n ? sum << k : sum >> -k;
}

/** e^x for a WAD x, as WAD (rounded down). Inputs under about -41.4 return 0. */
export function expWad(x: bigint): bigint {
  if (x < -42n * WAD) return 0n;
  if (x > 135n * WAD) throw new DetMathError("exp overflow");
  return expHi(x * HI_PER_WAD) / HI_PER_WAD;
}

function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a < 0n && q * b !== a ? q - 1n : q;
}

// ------------------------------------------------------------------ erfc and Phi (Cody's rational erfc)

const C = (s: string) => decHi(s);

/** Decimal string -> 1e36 bigint (exact for up to 36 fractional digits). */
function decHi(s: string): bigint {
  let neg = false;
  if (s.startsWith("-")) {
    neg = true;
    s = s.slice(1);
  }
  let [m, e = "0"] = s.toLowerCase().split("e");
  const exp = Number(e);
  let [i, f = ""] = m!.split(".");
  let digits = i! + f;
  let point = i!.length + exp;
  if (point < 0) {
    digits = "0".repeat(-point) + digits;
    point = 0;
  }
  const intPart = digits.slice(0, point).padEnd(point, "0") || "0";
  const frac = (digits.slice(point) + "0".repeat(36)).slice(0, 36);
  const v = BigInt(intPart) * HI + BigInt(frac);
  return neg ? -v : v;
}

// W. J. Cody, "Rational Chebyshev approximations for the error function", Math. Comp. 23 (1969); CALERF.
const A = ["3.16112374387056560e00", "1.13864154151050156e02", "3.77485237685302021e02", "3.20937758913846947e03", "1.85777706184603153e-1"].map(C);
const B = ["2.36012909523441209e01", "2.44024637934444173e02", "1.28261652607737228e03", "2.84423683343917062e03"].map(C);
const Cc = [
  "5.64188496988670089e-1", "8.88314979438837594e00", "6.61191906371416295e01", "2.98635138197400131e02",
  "8.81952221241769090e02", "1.71204761263407058e03", "2.05107837782607147e03", "1.23033935479799725e03",
  "2.15311535474403846e-8",
].map(C);
const D = [
  "1.57449261107098347e01", "1.17693950891312499e02", "5.37181101862009858e02", "1.62138957456669019e03",
  "3.29079923573345963e03", "4.36261909014324716e03", "3.43936767414372164e03", "1.23033935480374942e03",
].map(C);
const P = ["3.05326634961232344e-1", "3.60344899949804439e-1", "1.25781726111229246e-1", "1.60837851487422766e-2", "6.58749161529837803e-4", "1.63153871373020978e-2"].map(C);
const Q = ["2.56852019228982242e00", "1.87295284992346725e00", "5.27905102951428412e-1", "6.05183413124413191e-2", "2.33520497626869185e-3"].map(C);
const THRESH = C("0.46875");
const FOUR = 4n * HI;

const mul = (a: bigint, b: bigint) => (a * b) / HI;
const div = (a: bigint, b: bigint) => (a * HI) / b;

/** erfc(x) at 1e36 for any x. */
function erfcHi(x: bigint): bigint {
  const y = abs(x);
  if (y <= THRESH) {
    const ysq = mul(y, y);
    let xnum = mul(A[4]!, ysq);
    let xden = ysq;
    for (let i = 0; i < 3; i++) {
      xnum = mul(xnum + A[i]!, ysq);
      xden = mul(xden + B[i]!, ysq);
    }
    const erf = div(mul(x, xnum + A[3]!), xden + B[3]!);
    return HI - erf;
  }
  let r: bigint;
  if (y <= FOUR) {
    let xnum = mul(Cc[8]!, y);
    let xden = y;
    for (let i = 0; i < 7; i++) {
      xnum = mul(xnum + Cc[i]!, y);
      xden = mul(xden + D[i]!, y);
    }
    r = div(xnum + Cc[7]!, xden + D[7]!);
  } else {
    const ysq = div(HI, mul(y, y));
    let xnum = mul(P[5]!, ysq);
    let xden = ysq;
    for (let i = 0; i < 4; i++) {
      xnum = mul(xnum + P[i]!, ysq);
      xden = mul(xden + Q[i]!, ysq);
    }
    r = div(mul(ysq, xnum + P[4]!), xden + Q[4]!);
    r = div(INV_SQRT_PI_HI - r, y);
  }
  const ex = -mul(y, y);
  r = ex < -42n * HI ? 0n : mul(r, expHi(ex));
  return x < 0n ? 2n * HI - r : r;
}

/** erfc(x) for a WAD x, as WAD (rounded down). */
export function erfcWad(x: bigint): bigint {
  return erfcHi(x * HI_PER_WAD) / HI_PER_WAD;
}

/** Standard normal CDF: Phi(x) = erfc(-x / sqrt 2) / 2, WAD in and out (rounded down). */
export function phiWad(x: bigint): bigint {
  const xHi = x * HI_PER_WAD;
  const arg = -div(xHi, SQRT2_HI);
  return erfcHi(arg) / 2n / HI_PER_WAD;
}

/** Decimal string -> WAD bigint, rounded down (for rules JSON values like "0.52"). */
export function parseWad(s: string): bigint {
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new DetMathError(`not a plain decimal: ${s}`);
  return floorDiv(decHi(s), HI_PER_WAD);
}
