/** Fixed P-256 session keys for the arena tests, and signing an order the way the App does. */
import { p256 } from "@noble/curves/nist.js";
import { type Hex, bytesToHex, hexToBytes, keccak256, toHex } from "viem";
import type { Order } from "../src/arena/engine/orders";
import { encodeOrder } from "../src/arena/log/events";
import type { Recorder } from "../src/arena/log/record";

const secret = (i: number) => hexToBytes(keccak256(toHex(`arena test session key ${i}`)));
export const pubOf = (i: number): Hex => bytesToHex(p256.getPublicKey(secret(i), false));
export const signOrder = (i: number, table: Hex, o: Order): Hex =>
  bytesToHex(p256.sign(hexToBytes(encodeOrder(table, o)), secret(i), { prehash: true, lowS: false, format: "compact" }));
/** Record an order signed by seat i's key. */
export const put = (r: Recorder, i: number, o: Order, recvTs: number) => r.order(o, signOrder(i, r.open.table, o), recvTs);
