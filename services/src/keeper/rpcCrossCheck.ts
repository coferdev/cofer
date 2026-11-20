/**
 * RPC cross-check (keeper, every minute): compares the server's chain connection (RHC_RPC_URL) with the chain's own
 * public RPC. Read-only, and nothing is re-routed: every service keeps using its own RPC.
 *   - a different chain id: alert "rpc-wrong-chain" at once (the server would be reading the wrong chain);
 *   - the server's latest block more than RPC_LAG_BLOCKS behind the public one for RPC_LAG_FOR_SEC: alert "rpc-lagging".
 * The public RPC failing alone is only logged; the server's RPC failing is already the rpc-down alert.
 */
import { checkAlert, type AlertDeps } from "./alerts";
import { WHO } from "../core/alertFormat";

// The owner's settings.
export const RPC_LAG_BLOCKS = 300n; // about 30 seconds of Robinhood Chain blocks
export const RPC_LAG_FOR_SEC = 300; // 5 minutes
export const WRONG_CHAIN_ALERT = "rpc-wrong-chain";
export const LAGGING_ALERT = "rpc-lagging";

export interface RpcSide {
  chainId(): Promise<number>;
  head(): Promise<bigint>;
}

export interface CrossCheckDeps {
  server: RpcSide;
  publicRpc: RpcSide;
  expectedChainId: number;
  now(): number; // unix seconds
  /** When the server's RPC started lagging (kept between runs), or null. */
  laggingSince(): Promise<number | null>;
  setLaggingSince(t: number | null): Promise<void>;
  alerts: AlertDeps;
  log?(s: string): void;
}

const both = async <T>(a: () => Promise<T>, b: () => Promise<T>) => Promise.all([a().catch(() => null), b().catch(() => null)]);

export async function rpcCrossCheck(d: CrossCheckDeps): Promise<{ wrongChain: boolean; lagBlocks: bigint | null }> {
  const [sid, pid] = await both(() => d.server.chainId(), () => d.publicRpc.chainId());
  if (sid === null) return { wrongChain: false, lagBlocks: null }; // the server's RPC is down: rpc-down covers it
  const wrong = sid !== d.expectedChainId || (pid !== null && pid !== sid);
  await checkAlert(WRONG_CHAIN_ALERT, wrong ? { name: WRONG_CHAIN_ALERT, what: `The server's chain connection answers chain ${sid}, but the services run for chain ${d.expectedChainId}${pid !== null ? ` (the public RPC answers ${pid})` : ""}. The bot, indexer and jobs may be reading the wrong chain.`, who: WHO.emergency, emergency: true } : null, d.alerts);
  if (pid === null) {
    d.log?.("rpc cross-check: the public RPC did not answer; nothing compared");
    return { wrongChain: wrong, lagBlocks: null };
  }
  const [sh, ph] = await both(() => d.server.head(), () => d.publicRpc.head());
  if (sh === null || ph === null) return { wrongChain: wrong, lagBlocks: null };
  const lag = ph > sh ? ph - sh : 0n;
  const now = d.now();
  let since = await d.laggingSince();
  if (lag > RPC_LAG_BLOCKS) {
    if (since === null) await d.setLaggingSince((since = now));
  } else if (since !== null) await d.setLaggingSince((since = null));
  const lagging = since !== null && now - since >= RPC_LAG_FOR_SEC;
  await checkAlert(LAGGING_ALERT, lagging ? { name: LAGGING_ALERT, what: `The server's chain connection has been more than ${RPC_LAG_BLOCKS} blocks behind the public RPC for ${Math.floor((now - since!) / 60)} minutes (now ${lag} blocks: block ${sh} against ${ph}). Votes, members and balances shown may be late.`, who: WHO.dev } : null, d.alerts);
  return { wrongChain: wrong, lagBlocks: lag };
}
