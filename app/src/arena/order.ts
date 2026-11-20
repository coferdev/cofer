/**
 * Builds and signs an order exactly as the engine checks it: the canonical order bytes come from the engine's own
 * encoder (services/src/arena/log/events.ts), so the App and the engine can never disagree on what was signed.
 */
import type { Order } from '../../../services/src/arena/engine/orders';
import { encodeOrder } from '../../../services/src/arena/log/events';
import type { SeatKey } from './seatKey';

let last = 0n;
/** Nonces only go up, also across reloads: microseconds since 1970, bumped if two orders share one. */
export function nextNonce(now = Date.now()): bigint {
  const n = BigInt(now) * 1000n;
  last = n > last ? n : last + 1n;
  return last;
}

/** Decimal text → bigint with `dec` decimals (no floats; refuses anything that is not a plain positive number). */
export function units(text: string, dec: number): bigint | null {
  const s = text.trim().replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [i, f = ''] = s.split('.');
  if (f.length > dec) return null;
  const v = BigInt(i!) * 10n ** BigInt(dec) + BigInt((f + '0'.repeat(dec)).slice(0, dec) || '0');
  return v > 0n ? v : null;
}

export type OrderInput = Omit<Order, 'seat' | 'nonce' | 'clientId'>;

export async function signOrder(table: string, seat: string, key: SeatKey, x: OrderInput): Promise<{ order: Order; bytes: string; sig: string }> {
  const nonce = nextNonce();
  const order = { ...x, seat: seat.toLowerCase(), nonce, clientId: `a${nonce.toString(36)}` } as Order;
  const bytes = encodeOrder(table as `0x${string}`, order);
  return { order, bytes, sig: await key.sign(bytes) };
}
