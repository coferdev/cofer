import { describe, expect, test } from "bun:test";
import { p256 } from "@noble/curves/nist.js";
import { type Hex, bytesToHex, hexToBytes, keccak256 } from "viem";
import type { Order } from "../src/arena/engine/orders";
import { isSessionKey, keyProblems, orderSigProblem, sessionKeyHash, verifyOrderSig } from "../src/arena/engine/session";
import { encodeOrder } from "../src/arena/log/events";
import { type Open, Recorder } from "../src/arena/log/record";
import { PRACTICE_RULES } from "../src/arena/engine/orders";
import { pubOf, signOrder } from "./arenaKeys";

const TABLE = "0x00000000000000000000000000000000000000aa" as Hex;
const SEAT = "0x00000000000000000000000000000000000000a1" as Hex;
const order: Order = { seat: SEAT, nonce: 1n, kind: "MARKET", symbol: "BTC", product: "PERP", side: "BUY", qty: 10_000_000n, leverage: 2n, clientId: "k1" };
const N = p256.Point.CURVE().n;

describe("arena session keys", () => {
  test("a key made and used by WebCrypto, as in the App, verifies here", async () => {
    const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as CryptoKeyPair;
    const pub = bytesToHex(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
    expect(isSessionKey(pub)).toBe(true);
    const bytes = encodeOrder(TABLE, order);
    for (let i = 0; i < 8; i++) {
      const sig = bytesToHex(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, new Uint8Array(hexToBytes(bytes)))));
      expect(verifyOrderSig(pub, bytes, sig)).toBe(true);
    }
    expect(sessionKeyHash(pub)).toBe(keccak256(pub));
  });

  test("both halves of s verify (WebCrypto does not normalise); a changed order, key or signature does not", () => {
    const pub = pubOf(0);
    const bytes = encodeOrder(TABLE, order);
    const sig = hexToBytes(signOrder(0, TABLE, order));
    const s = BigInt(bytesToHex(sig.slice(32)));
    const flipped = new Uint8Array(sig);
    flipped.set(hexToBytes(`0x${(N - s).toString(16).padStart(64, "0")}`), 32);
    expect(verifyOrderSig(pub, bytes, bytesToHex(sig))).toBe(true);
    expect(verifyOrderSig(pub, bytes, bytesToHex(flipped))).toBe(true);
    expect(verifyOrderSig(pub, encodeOrder(TABLE, { ...order, qty: 10_000_001n }), bytesToHex(sig))).toBe(false);
    expect(verifyOrderSig(pub, encodeOrder("0x00000000000000000000000000000000000000ab", order), bytesToHex(sig))).toBe(false);
    expect(verifyOrderSig(pubOf(1), bytes, bytesToHex(sig))).toBe(false);
    expect(verifyOrderSig(pub, bytes, "0x")).toBe(false);
    expect(verifyOrderSig(pub, bytes, bytesToHex(new Uint8Array(64)))).toBe(false);
    expect(verifyOrderSig("0x02", bytes, bytesToHex(sig))).toBe(false);
  });

  test("GameOpen keys must be points and hash to each seat's on-chain sessionKeyHash", () => {
    const seats = [SEAT, "0x00000000000000000000000000000000000000a2" as Hex];
    const chain = new Map(seats.map((a, i) => [a.toLowerCase(), sessionKeyHash(pubOf(i))]));
    expect(keyProblems(seats, [pubOf(0), pubOf(1)], chain)).toEqual([]);
    expect(keyProblems(seats, [pubOf(1), pubOf(0)], chain).length).toBe(2);
    expect(keyProblems(seats, [pubOf(0)], chain)).toEqual(["2 seats but 1 session keys"]);
    const notPoint = `0x04${"11".repeat(64)}` as Hex;
    expect(keyProblems(seats, [pubOf(0), notPoint], chain)[0]).toContain("not a P-256 point");
    expect(orderSigProblem(seats, [pubOf(0), pubOf(1)], "0x00000000000000000000000000000000000000ff", encodeOrder(TABLE, order), signOrder(0, TABLE, order))).toContain("has no seat");
  });

  test("the recorder never logs an order whose signature fails", () => {
    const open: Open = { chainId: 46630, table: TABLE, rulesHash: `0x${"0".repeat(64)}`, rulesJson: "{}", seats: [SEAT], pubkeys: [pubOf(0)], lockedAt: 0, endAt: 86_400_000, lockBlock: 1n, tapeHours: [] };
    const r = new Recorder(open, PRACTICE_RULES);
    const before = r.log.length;
    expect(() => r.order(order, signOrder(1, TABLE, order), 1_000)).toThrow("order not logged");
    expect(r.log.length).toBe(before);
    r.order(order, signOrder(0, TABLE, order), 1_000);
    expect(r.log.length).toBeGreaterThan(before);
  });
});
