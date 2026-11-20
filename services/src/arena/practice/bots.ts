/**
 * Practice bots: seats that trade on their own, so a Practice game can run (and be checked) with no person at the
 * table. Each bot has its own P-256 session key and signs every order the way the App does (canonical order bytes,
 * SHA-256, raw r ‖ s). Their keys are derived from the game id and their number, so a test can sign the same way.
 */
import { p256 } from "@noble/curves/nist.js";
import { type Hex, bytesToHex, getAddress, hexToBytes, keccak256, slice, toHex } from "viem";
import type { Order } from "../engine/orders";
import { encodeOrder } from "../log/events";
import type { PracticeSeat } from "./practice";

export class PracticeBot {
  readonly seat: PracticeSeat;
  private readonly secret: Uint8Array;
  private nonce = 0n;
  private tickN = 0;

  constructor(readonly game: string, readonly n: number, private readonly table: Hex) {
    this.secret = hexToBytes(keccak256(toHex(`cofer practice bot ${game} ${n}`)));
    this.seat = {
      address: getAddress(slice(keccak256(toHex(`cofer practice bot address ${game} ${n}`)), 12)),
      pubkey: bytesToHex(p256.getPublicKey(this.secret, false)),
    };
  }

  sign(o: Order): { bytes: Hex; sig: Hex } {
    const bytes = encodeOrder(this.table, o);
    return { bytes, sig: bytesToHex(p256.sign(hexToBytes(bytes), this.secret, { prehash: true, lowS: false, format: "compact" })) };
  }

  private order(x: Omit<Order, "seat" | "nonce" | "clientId">): { bytes: Hex; sig: Hex } {
    this.nonce++;
    return this.sign({ seat: this.seat.address.toLowerCase(), nonce: this.nonce, clientId: `b${this.n}-${this.nonce}`, ...x } as Order);
  }

  /**
   * What the bot sends after a tick, if anything. A simple, varied pattern: each bot opens a position on its own
   * schedule (BTC or ETH, long or short, its own leverage), holds it past the 60 s minimum, closes it, and repeats.
   */
  afterTick(): { bytes: Hex; sig: Hex }[] {
    this.tickN++;
    const period = 120 + 15 * (this.n % 4);
    const phase = (this.tickN + 7 * this.n) % period;
    const sym = this.n % 2 === 0 ? "BTC" : "ETH";
    if (phase === 3) {
      const side = (Math.floor((this.tickN + 7 * this.n) / period) + this.n) % 2 === 0 ? "BUY" : "SELL";
      return [this.order({ kind: "MARKET", symbol: sym, product: "PERP", side, pctFreeBps: BigInt(1500 + 500 * (this.n % 5)), leverage: BigInt(2 + (this.n % 4) * 2) })];
    }
    if (phase === 3 + 75) return [this.order({ kind: "CLOSE", symbol: sym, product: "PERP" })];
    return [];
  }
}
