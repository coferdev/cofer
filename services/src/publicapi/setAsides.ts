/**
 * GET /v1/set-asides/:address: every token still set aside for an address, across all group accounts (the set-aside
 * ledger, docs/ledgers.md), each with the claim to make. Anyone may send the claim: claimOwed(token, address) always
 * pays the address itself, never the sender.
 */
import { encodeFunctionData, getAddress, type Address } from "viem";

export const SET_ASIDES_CACHE_MS = 15_000;

export interface SetAsidesDeps {
  /** The ledger's rows for this recipient. */
  rowsFor(account: string): Promise<{ pot: string; asset: string; setAside: string; claimed: string; lastBlock: bigint }[]>;
  token(a: Address): Promise<{ symbol: string; decimals: number } | null>;
  rpcUrl: string;
}

const CLAIM_ABI = [{ type: "function", name: "claimOwed", stateMutability: "nonpayable", inputs: [{ name: "asset", type: "address" }, { name: "account", type: "address" }], outputs: [] }] as const;

export async function readSetAsides(d: SetAsidesDeps, account: Address) {
  const rows = (await d.rowsFor(account)).filter((r) => BigInt(r.setAside) > BigInt(r.claimed));
  const open = await Promise.all(
    rows.map(async (r) => {
      const pot = getAddress(r.pot);
      const asset = getAddress(r.asset);
      const t = await d.token(asset);
      return {
        pot,
        asset,
        symbol: t?.symbol ?? null,
        decimals: t?.decimals ?? null,
        open: (BigInt(r.setAside) - BigInt(r.claimed)).toString(),
        lastBlock: r.lastBlock,
        claim: {
          to: pot,
          data: encodeFunctionData({ abi: CLAIM_ABI, functionName: "claimOwed", args: [asset, account] }),
          function: "claimOwed(address,address)",
          note: "Anyone may send this; the tokens always go to the address set aside for.",
        },
        check: `cast call ${pot} "owed(address,address)(uint256)" ${asset} ${account} --rpc-url ${d.rpcUrl}`,
      };
    }),
  );
  return { address: account, open: open.sort((a, b) => (a.pot + a.asset).localeCompare(b.pot + b.asset)) };
}
