/**
 * Money on the dashboard is always an integer of raw token units (a decimal string from the API, or
 * a bigint) plus that token's decimals. These helpers never turn an amount into a JavaScript number:
 * a number loses digits past 2^53 and cannot hold most decimal fractions exactly.
 */

const INT = /^-?\d+$/;

/** True if `v` is a whole number of raw units (a bigint, or a string of digits). */
export function isAmount(v: unknown): v is string | bigint {
  return typeof v === 'bigint' || (typeof v === 'string' && INT.test(v));
}

export function toBig(v: string | bigint): bigint {
  return typeof v === 'bigint' ? v : BigInt(v);
}

function group(int: string): string {
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * A raw amount shown with its token's decimals, cut (never rounded up) to `maxFraction` digits,
 * trailing zeros dropped, thousands grouped: formatAmount("1234567890", 6) = "1,234.56".
 * Anything that is not a whole number of units shows as "—" rather than a wrong figure.
 */
export function formatAmount(raw: string | bigint | null | undefined, decimals: number, maxFraction = 2): string {
  if (raw === null || raw === undefined || !isAmount(raw) || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return '—';
  let v = toBig(raw);
  const neg = v < 0n;
  if (neg) v = -v;
  const base = 10n ** BigInt(decimals);
  const int = (v / base).toString();
  let frac = decimals ? (v % base).toString().padStart(decimals, '0').slice(0, Math.max(0, maxFraction)) : '';
  frac = frac.replace(/0+$/, '');
  const out = `${group(int)}${frac ? `.${frac}` : ''}`;
  return neg && out !== '0' ? `-${out}` : out;
}

/** Basis points as a percentage with up to two decimals: 3333 -> "33.33", 5000 -> "50". */
export function formatBps(bps: number | null | undefined): string {
  if (bps === null || bps === undefined || !Number.isInteger(bps) || bps < 0) return '—';
  const whole = Math.floor(bps / 100);
  const rest = String(bps % 100).padStart(2, '0').replace(/0+$/, '');
  return rest ? `${whole}.${rest}` : String(whole);
}

/** v / max between 0 and 1, for drawing bar heights only (never for money shown as text). */
export function ratio(v: string | bigint, max: string | bigint): number {
  const a = toBig(v);
  const b = toBig(max);
  if (b <= 0n || a <= 0n) return 0;
  if (a >= b) return 1;
  return Number((a * 10_000n) / b) / 10_000;
}

/** The largest of some raw amounts (0 when there are none). */
export function maxAmount(values: (string | bigint)[]): bigint {
  return values.reduce<bigint>((m, v) => (isAmount(v) && toBig(v) > m ? toBig(v) : m), 0n);
}
