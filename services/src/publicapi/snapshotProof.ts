/**
 * GET /v1/proof/snapshot/:pot?block=N: every token a group account held at a block, its raw balance and the part
 * reserved for set-aside claims, each with the exact read-only command (block number included) to check it.
 * Without a block: the newest block the indexer would count (head minus confirmations).
 * Old blocks need an archive RPC. When the server's RPC cannot answer for that block, the answer says so and still
 * gives the commands, to run on an archive RPC.
 */
import { getAddress, type Address } from "viem";

export interface SnapshotProofDeps {
  head(): Promise<bigint>;
  confirmations: number;
  heldAt(pot: Address, block: bigint): Promise<readonly Address[]>;
  balanceAt(token: Address, holder: Address, block: bigint): Promise<bigint>;
  reservedAt(pot: Address, token: Address, block: bigint): Promise<bigint>;
  token(a: Address): Promise<{ symbol: string; decimals: number } | null>;
  rpcUrl: string;
}

const call = (rpc: string, contract: string, sig: string, args: string[], block: bigint) => `cast call ${contract} "${sig}"${args.map((a) => ` ${a}`).join("")} --block ${block} --rpc-url ${rpc}`;

export async function readSnapshotProof(d: SnapshotProofDeps, pot: Address, blockIn: bigint | null) {
  const head = await d.head();
  const block = blockIn ?? head - BigInt(d.confirmations);
  if (block > head) return { tooNew: true as const, head };
  const heldCmd = call(d.rpcUrl, pot, "heldAssets()(address[])", [], block);
  let held: readonly Address[];
  try {
    held = await d.heldAt(pot, block);
  } catch {
    return { pot, block, readable: false, note: "The server's RPC keeps recent state only and cannot read this block. Run the commands on an archive RPC.", assets: null, checks: [{ what: "The tokens it held at this block", command: heldCmd }] };
  }
  const assets = await Promise.all(
    held.map(async (a) => {
      const asset = getAddress(a);
      const [rawBalance, reserved, t] = await Promise.all([d.balanceAt(asset, pot, block), d.reservedAt(pot, asset, block), d.token(asset)]);
      return {
        asset,
        symbol: t?.symbol ?? null,
        decimals: t?.decimals ?? null,
        rawBalance,
        reserved,
        checks: [
          { what: "Raw balance", command: call(d.rpcUrl, asset, "balanceOf(address)(uint256)", [pot], block) },
          { what: "Reserved for set-aside claims (the rest is what exits share)", command: call(d.rpcUrl, pot, "reserved(address)(uint256)", [asset], block) },
        ],
      };
    }),
  );
  return { pot, block, readable: true, assets, checks: [{ what: "The tokens it held at this block", command: heldCmd }] };
}

export function blockParam(s: string | undefined): bigint | null | "bad" {
  if (s === undefined || s === "") return null;
  return /^\d{1,20}$/.test(s) ? BigInt(s) : "bad";
}
