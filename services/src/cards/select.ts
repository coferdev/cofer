/**
 * The one rule for which card adapter may run. Cards are optional and OFF by default.
 *  - off:      no cards; /card is hidden and the card API refuses.
 *  - stub:     testnet (46630) only. It issues no real card, so on any other chain start-up stops.
 *              It needs an explicit funding address: there is no default, and burn addresses are refused.
 *  - provider: implemented out of band; start-up stops until it exists.
 */
import { getAddress, zeroAddress, type Address } from "viem";
import type { CardAdapter } from "./CardAdapter";
import { StubCardAdapter } from "./StubCardAdapter";

export const TESTNET_CHAIN_ID = 46630;

const BURN_ADDRESSES = new Set<string>([zeroAddress, "0x000000000000000000000000000000000000dead"]);

export interface CardSettings {
  CHAIN_ID: number;
  CARD_ADAPTER: "off" | "stub" | "provider";
  CARD_STUB_FUNDING_ADDRESS?: string;
}

/** Throws (stops start-up) on a setting that must never run; returns null when cards are off. */
export function selectCardAdapter(s: CardSettings): CardAdapter | null {
  switch (s.CARD_ADAPTER) {
    case "off":
      return null;
    case "stub": {
      if (s.CHAIN_ID !== TESTNET_CHAIN_ID) {
        throw new Error(`CARD_ADAPTER=stub is for testnet (${TESTNET_CHAIN_ID}) only: it issues no real card. Set CARD_ADAPTER=off on chain ${s.CHAIN_ID}.`);
      }
      if (!s.CARD_STUB_FUNDING_ADDRESS) throw new Error("CARD_ADAPTER=stub needs CARD_STUB_FUNDING_ADDRESS (a testnet address you control)");
      const to: Address = getAddress(s.CARD_STUB_FUNDING_ADDRESS);
      if (BURN_ADDRESSES.has(to.toLowerCase())) throw new Error("CARD_STUB_FUNDING_ADDRESS must not be a burn address");
      return new StubCardAdapter(to);
    }
    case "provider":
      throw new Error("Provider card adapter is out of band: implement CardAdapter for the provider's API (see cards/CardAdapter.ts)");
  }
}

/** True when a card adapter will run. Throws on the same settings selectCardAdapter refuses. */
export function cardsAvailable(s: CardSettings): boolean {
  return selectCardAdapter(s) !== null;
}
