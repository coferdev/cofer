/**
 * Which key the signer page offers. The saved kind decides everything and the two are never mixed:
 *  - /s/:token is the passkey page (strict security policy, no wallet code loaded);
 *  - /w/:token is the wallet page (Connect wallet; its policy lets the wallet window run).
 * A wallet member (kernel-ecdsa) opening /s/ is sent to /w/, and anyone else opening /w/ for an
 * action is sent back to /s/. Moving between them reads the link without using it up.
 * Only sign-up offers a choice: the passkey page shows both buttons (Connect wallet opens /w/).
 */
import { isWalletKind } from "./accountKind";

export type PageMode = "passkey" | "wallet";

export type KeyChoice = {
  /** open the other page instead (same link, not used up) */
  redirect: PageMode | null;
  /** the passkey action is offered */
  passkey: boolean;
  /** the Connect wallet button is shown */
  wallet: boolean;
  /** a wallet page while Connect wallet is off on this server: say so, offer nothing */
  walletOff: boolean;
};

export function keyChoice(o: { mode: PageMode; purpose: string; kind: string | null | undefined; walletOn: boolean }): KeyChoice {
  const none = { redirect: null, passkey: false, wallet: false, walletOff: false };
  if (o.purpose === "onboard") {
    if (o.mode === "passkey") return { ...none, passkey: true, wallet: o.walletOn };
    return o.walletOn ? { ...none, wallet: true } : { ...none, walletOff: true };
  }
  if (isWalletKind(o.kind)) {
    if (o.mode === "passkey") return { ...none, redirect: "wallet" };
    return o.walletOn ? { ...none, wallet: true } : { ...none, walletOff: true };
  }
  if (o.mode === "wallet") return { ...none, redirect: "passkey" };
  return { ...none, passkey: true };
}

/** The other page for the same link. */
export function pagePath(mode: PageMode, token: string): string {
  return `/${mode === "wallet" ? "w" : "s"}/${encodeURIComponent(token)}`;
}
