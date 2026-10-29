/**
 * Optional member cards. Card issuance is OUT OF BAND: a third-party card provider issues the card;
 * Cofer only moves USDG from a member's on-chain allowance to the provider's funding address via
 * CoferPot.spend(to, amount, memo). The group account works fully without any card.
 *
 *   member taps "Load card" -> adapter.quote() -> member signs spend() from their allowance
 *   (userOp from the signer site) -> adapter.confirm(txHash) -> provider issues/loads the card
 *
 * Nothing here holds keys or funds. If the provider fails, the order is marked failed and any
 * refund is the provider's obligation (disclosed in the honest-limits section).
 */
import type { Address, Hex } from "viem";

export interface CardQuote {
  orderId: string;
  fundingAddress: Address; // where spend() sends USDG
  amountUsdg: bigint; // 6 dp, includes provider load fee
  loadFeeUsdg: bigint;
  memo: Hex; // bytes32 passed to spend() so the provider can match the payment
  expiresAt: number;
}

export interface CardStatus {
  orderId: string;
  status: "quoted" | "funded" | "issued" | "failed" | "refunded";
  deliveredTo?: "email" | "app";
  last4?: string;
}

export interface CardAdapter {
  readonly name: string;
  /** Regions/limits are the provider's; return null if unavailable for this member. */
  quote(args: { pot: Address; member: Address; amountUsdg: bigint; email?: string }): Promise<CardQuote | null>;
  confirm(args: { orderId: string; spendTx: Hex }): Promise<CardStatus>;
  status(orderId: string): Promise<CardStatus>;
}
