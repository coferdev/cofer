/**
 * Chain guard (every role, at start-up, before anything else): the services refuse to start when what they are
 * connected to is not CHAIN_ID. This catches testnet settings on the mainnet server, and the reverse.
 *   - the server's RPC (RHC_RPC_URL) and the signer page's RPC must answer CHAIN_ID;
 *   - a chain number written in BUNDLER_URL or PAYMASTER_URL (for example ".../chain/4663") must be CHAIN_ID.
 * Each problem is one plain sentence; no URL is ever printed (they can hold keys).
 */

export interface ChainGuardInput {
  chainId: number;
  serverRpcChainId(): Promise<number>;
  signerRpcChainId(): Promise<number>;
  bundlerUrl?: string;
  paymasterUrl?: string;
}

/** The chain number a provider URL names, if it names one (path "/chain/<n>" or "/chains/<n>", or "chainId=<n>"). */
export function chainInUrl(url: string | undefined): number | null {
  if (!url) return null;
  const m = /\/chains?\/(\d{1,9})(?:[/?#]|$)/.exec(url) ?? /[?&]chain[_-]?id=(\d{1,9})/i.exec(url);
  return m ? Number(m[1]) : null;
}

export async function chainGuardProblems(i: ChainGuardInput): Promise<string[]> {
  const out: string[] = [];
  const check = async (what: string, read: () => Promise<number>) => {
    let id: number;
    try {
      id = await read();
    } catch {
      out.push(`${what} did not answer, so its chain could not be checked.`);
      return;
    }
    if (id !== i.chainId) out.push(`${what} is on chain ${id}, but CHAIN_ID is ${i.chainId}.`);
  };
  await check("The server's RPC (RHC_RPC_URL)", i.serverRpcChainId);
  await check("The signer page's RPC", i.signerRpcChainId);
  for (const [name, url] of [["BUNDLER_URL", i.bundlerUrl], ["PAYMASTER_URL", i.paymasterUrl]] as const) {
    const n = chainInUrl(url);
    if (n !== null && n !== i.chainId) out.push(`${name} is for chain ${n}, but CHAIN_ID is ${i.chainId}.`);
  }
  return out;
}

export async function assertChain(i: ChainGuardInput): Promise<void> {
  const why = await chainGuardProblems(i);
  if (why.length) throw new Error(`Chain guard: not starting. ${why.join(" ")}`);
}
