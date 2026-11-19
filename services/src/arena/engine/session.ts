/**
 * Session keys (spec §3.4, §4.4, §4.8). Each seat signs its orders with a per-game P-256 key held in the App
 * (WebCrypto, non-extractable). On-chain the table stores sessionKeyHash = keccak256(uncompressed public key, 65
 * bytes 0x04 ‖ x ‖ y). An order counts only when its signature over the canonical order bytes (encodeOrder) verifies
 * under that seat's key: ECDSA P-256 over SHA-256, the raw 64-byte r ‖ s that WebCrypto produces. WebCrypto does not
 * normalise s, so both halves are accepted; the log records the exact bytes either way.
 */
import { p256 } from "@noble/curves/nist.js";
import { type Hex, hexToBytes, keccak256 } from "viem";

export const sessionKeyHash = (pub: Hex): Hex => keccak256(pub);

/** True when `pub` is a 65-byte uncompressed point on P-256. */
export function isSessionKey(pub: Hex): boolean {
  try {
    const b = hexToBytes(pub);
    if (b.length !== 65 || b[0] !== 4) return false;
    p256.Point.fromBytes(b).assertValidity();
    return true;
  } catch {
    return false;
  }
}

export function verifyOrderSig(pub: Hex, orderBytes: Hex, sig: Hex): boolean {
  try {
    const s = hexToBytes(sig);
    if (s.length !== 64 || !isSessionKey(pub)) return false;
    return p256.verify(s, hexToBytes(orderBytes), hexToBytes(pub), { prehash: true, lowS: false, format: "compact" });
  } catch {
    return false;
  }
}

/** GameOpen's keys against the table's on-chain seats: one per seat, each a valid point hashing to its sessionKeyHash. */
export function keyProblems(seats: Hex[], pubkeys: Hex[], onChain: Map<string, Hex>): string[] {
  const out: string[] = [];
  if (seats.length !== pubkeys.length) out.push(`${seats.length} seats but ${pubkeys.length} session keys`);
  seats.forEach((seat, i) => {
    const pub = pubkeys[i];
    const want = onChain.get(seat.toLowerCase());
    if (!pub) return;
    if (!isSessionKey(pub)) out.push(`seat ${seat}: the session key is not a P-256 point`);
    else if (!want) out.push(`seat ${seat}: no seat on chain`);
    else if (sessionKeyHash(pub) !== want.toLowerCase()) out.push(`seat ${seat}: the session key does not hash to the on-chain sessionKeyHash`);
  });
  return out;
}

/** The check before an order enters the log: the signer is a seat of this game and the signature verifies. */
export function orderSigProblem(seats: Hex[], pubkeys: Hex[], seat: Hex, orderBytes: Hex, sig: Hex): string | null {
  const i = seats.findIndex((s) => s.toLowerCase() === seat.toLowerCase());
  if (i < 0) return `${seat} has no seat`;
  return verifyOrderSig(pubkeys[i]!, orderBytes, sig) ? null : `the signature does not verify under ${seat}'s session key`;
}
