/**
 * The per-game seat key (spec §6.6): a WebCrypto P-256 key whose private half can never leave this browser
 * (non-extractable), kept in IndexedDB under the game. Orders are signed with it (SHA-256, raw r ‖ s); the server
 * checks every signature before an order enters the game's log. A lost device means the seat cannot trade any more.
 */
const DB = 'cofer-arena';
const STORE = 'seat-keys';

function db(): Promise<IDBDatabase> {
  return new Promise((ok, no) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => ok(r.result);
    r.onerror = () => no(r.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((ok, no) => {
    const r = f(d.transaction(STORE, mode).objectStore(STORE));
    r.onsuccess = () => ok(r.result);
    r.onerror = () => no(r.error);
  });
}

export const toHex = (b: ArrayBuffer | Uint8Array) => `0x${[...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
export function fromHex(h: string): Uint8Array<ArrayBuffer> {
  const s = h.startsWith('0x') ? h.slice(2) : h;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export interface SeatKey {
  pubkey: string; // 65-byte uncompressed point, hex
  sign: (bytes: string) => Promise<string>;
}

const wrap = async (k: CryptoKeyPair): Promise<SeatKey> => ({
  pubkey: toHex(await crypto.subtle.exportKey('raw', k.publicKey)),
  sign: async (bytes) => toHex(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, k.privateKey, fromHex(bytes))),
});

/** A new key for a game about to start. Saved under the game once the server says which game it is. */
export async function newSeatKey(): Promise<{ key: SeatKey; save: (game: string) => Promise<void> }> {
  const k = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])) as CryptoKeyPair;
  return { key: await wrap(k), save: async (game) => void (await tx('readwrite', (s) => s.put(k, game))) };
}

export async function loadSeatKey(game: string): Promise<SeatKey | null> {
  const k = (await tx('readonly', (s) => s.get(game))) as CryptoKeyPair | undefined;
  return k ? wrap(k) : null;
}
