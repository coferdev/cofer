import { keccak256, toHex, type Address, type Hex } from "viem";
import type { CardAdapter, CardQuote, CardStatus } from "./CardAdapter";

/**
 * Development stub. Behaves like a provider that charges a flat 1.5% load fee and "issues" a card
 * once the spend tx is reported. Swap for the real provider adapter (CARD_ADAPTER=provider) once
 * its API contract is confirmed out of band.
 */
export class StubCardAdapter implements CardAdapter {
  readonly name = "stub";
  private orders = new Map<string, CardStatus>();

  constructor(private readonly fundingAddress: Address = "0x000000000000000000000000000000000000dEaD") {}

  async quote(args: { pot: Address; member: Address; amountUsdg: bigint }): Promise<CardQuote | null> {
    if (args.amountUsdg < 10_000_000n) return null; // 10 USDG minimum
    const orderId = crypto.randomUUID();
    const loadFeeUsdg = (args.amountUsdg * 150n) / 10_000n;
    this.orders.set(orderId, { orderId, status: "quoted" });
    return {
      orderId,
      fundingAddress: this.fundingAddress,
      amountUsdg: args.amountUsdg + loadFeeUsdg,
      loadFeeUsdg,
      memo: keccak256(toHex(orderId)) as Hex,
      expiresAt: Math.floor(Date.now() / 1000) + 15 * 60,
    };
  }

  async confirm(args: { orderId: string; spendTx: Hex }): Promise<CardStatus> {
    const o = this.orders.get(args.orderId);
    if (!o) throw new Error("unknown order");
    const next: CardStatus = { orderId: o.orderId, status: "issued", deliveredTo: "email", last4: "0000" };
    this.orders.set(o.orderId, next);
    return next;
  }

  async status(orderId: string): Promise<CardStatus> {
    const o = this.orders.get(orderId);
    if (!o) throw new Error("unknown order");
    return o;
  }
}
