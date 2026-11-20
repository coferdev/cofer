/** Display helpers. Chips are 1e6 (a Practice stack is 10,000.00), prices and quantities 1e8. All input is decimal text. */
function scaled(v: string | bigint | null | undefined, dec: number, places: number): string {
  if (v === null || v === undefined) return '–';
  let n = BigInt(v);
  const neg = n < 0n;
  if (neg) n = -n;
  const unit = 10n ** BigInt(dec);
  const step = 10n ** BigInt(dec - places);
  n = (n + step / 2n) / step; // round half up, for display only
  const whole = n / 10n ** BigInt(places);
  const frac = places ? `.${(n % 10n ** BigInt(places)).toString().padStart(places, '0')}` : '';
  void unit;
  return `${neg ? '-' : ''}${whole.toLocaleString('en-US')}${frac}`;
}

export const chips = (v: string | bigint | null | undefined) => scaled(v, 6, 2);
export const price = (v: string | bigint | null | undefined) => scaled(v, 8, 2);
export const qty = (v: string | bigint | null | undefined) => scaled(v, 8, 4);
export const signedChips = (v: string | null | undefined) => (v === null || v === undefined ? '–' : `${BigInt(v) > 0n ? '+' : ''}${chips(v)}`);

export function left(ms: number): string {
  if (ms <= 0) return '0:00';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export const clock = (ts: number) => new Date(ts).toISOString().slice(11, 19) + ' UTC';

/** The engine's refusal codes, in plain words. */
export const REASONS: Record<string, string> = {
  NO_MARK: 'No fresh price arrived in time, so it did not fill.',
  HOLD: 'Positions are held at least 60 seconds before they can be reduced or closed.',
  MARGIN: 'Not enough free margin for that size.',
  CLOSED_MARKET: 'That market is closed right now.',
  RATE: 'Too many orders in one second.',
  NONCE: 'That order was already sent.',
  CAP: 'Above the leverage cap or the order limit.',
  ELIMINATED: 'Your seat is out of this game.',
  QTY: 'That size does not work here.',
  MARKET: 'That market is not in this game.',
  EXPIRED: 'The game is not running.',
  NOT_FOUND: 'Nothing to cancel.',
  SIGNATURE: 'This device does not hold the key for your seat.',
  OTHER_TABLE: 'That order was for another game.',
  NOT_CANONICAL: 'That order was not encoded the way the engine reads it.',
  BAD_ORDER: 'That order could not be read.',
  CLOSED: 'The game has ended.',
  DISCONNECTED: 'Not connected. Reconnecting…',
  TIMEOUT: 'No answer from the server. Check the orders list before sending again.',
};
