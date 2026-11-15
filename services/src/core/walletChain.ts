/**
 * Getting a member's wallet onto the right Robinhood Chain (from the page's own config: 46630
 * testnet or 4663 mainnet) before anything is signed. Pure, so it is unit-tested; the page does the
 * wallet calls (switch, or add the network when the wallet does not know it, then switch).
 */

/** The network's name as the wallet shows it. */
export function chainName(chainId: number): string {
  return chainId === 46630 ? "Robinhood Chain Testnet" : chainId === 4663 ? "Robinhood Chain" : `Chain ${chainId}`;
}

/** Shown when the wallet stays on another network (it refused, or cannot switch). */
export function wrongNetworkText(chainId: number): string {
  return `Your wallet is on a different network. Switch it to ${chainName(chainId)} and try again. Nothing was sent.`;
}

/** The server has no Reown project ID or the wallet code did not build: the passkey still works. */
export const WALLET_OFF_TEXT = "Connect wallet is not available right now. Nothing was sent. Try again later.";

type ErrLike = { code?: unknown; message?: unknown; details?: unknown; cause?: unknown };

/**
 * True when the switch failed because the wallet does not know the network yet (EIP-3326 code 4902,
 * also when wrapped, or the "unrecognized chain" text some wallets send instead). Then the page adds it.
 */
export function needsAddChain(e: unknown): boolean {
  for (let x = e as ErrLike | undefined, i = 0; x && typeof x === "object" && i < 8; x = x.cause as ErrLike | undefined, i++) {
    if (x.code === 4902) return true;
    if (/unrecognized chain|unknown chain|chain .*not (been )?added|try adding the chain/i.test(`${String(x.message ?? "")} ${String(x.details ?? "")}`)) return true;
  }
  return false;
}
