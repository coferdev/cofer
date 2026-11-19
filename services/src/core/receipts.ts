/**
 * Receipts: one Cofer action, read from its transaction's own logs, with every figure and the exact read-only
 * commands that check each one against the chain (block numbers included). Built only from Cofer contract logs (a
 * group account the factory confirms); anything else in the transaction is left out.
 */
import { decodeEventLog, getAddress, type Address, type Hex } from "viem";
import { coferPotAbi } from "../chain/abi";
import type { TxReceiptLike } from "./txExplain";

export interface ReceiptDeps {
  isPot(a: Address): Promise<boolean>;
  token(a: Address): Promise<{ symbol: string; decimals: number } | null>;
  rpcUrl: string; // the chain's public RPC, printed in the commands
  chainId: number;
}

export interface CheckLine {
  what: string;
  command: string;
}

type Decoded = { address: Address; logIndex: number; eventName: string; args: Record<string, unknown> };

/** The group-account logs of a transaction, decoded, in order. */
export async function potLogs(r: TxReceiptLike, d: Pick<ReceiptDeps, "isPot">): Promise<Decoded[]> {
  const out: Decoded[] = [];
  const known = new Map<string, boolean>();
  for (const l of r.logs) {
    const k = l.address.toLowerCase();
    if (!known.has(k)) known.set(k, await d.isPot(l.address));
    if (!known.get(k)) continue;
    try {
      const ev = decodeEventLog({ abi: coferPotAbi, data: l.data, topics: l.topics as [Hex, ...Hex[]] }) as unknown as { eventName: string; args: Record<string, unknown> };
      out.push({ address: getAddress(l.address), logIndex: l.logIndex, ...ev });
    } catch {
      /* not a group-account log */
    }
  }
  return out;
}

/** One read-only command, at a block when given. */
export const castCall = (rpc: string, contract: string, sig: string, args: (string | number | bigint)[], block?: bigint) =>
  `cast call ${contract} "${sig}"${args.map((a) => ` ${a}`).join("")}${block !== undefined ? ` --block ${block}` : ""} --rpc-url ${rpc}`;

export interface ExitReceipt {
  kind: "exit";
  chainId: number;
  tx: Hex;
  block: bigint;
  pot: Address;
  member: Address;
  to: Address;
  sharesBurned: bigint;
  /** Per token: its share of the exit, what was sent now, and what was set aside for the destination to claim. */
  assets: { asset: Address; symbol: string | null; decimals: number | null; amount: bigint; sent: bigint; setAside: bigint }[];
  checks: CheckLine[];
}

export async function exitReceipt(r: TxReceiptLike, d: ReceiptDeps): Promise<ExitReceipt | null> {
  if (r.status !== "success") return null;
  const logs = await potLogs(r, d);
  const ex = logs.find((l) => l.eventName === "Exited");
  if (!ex) return null;
  const owedLogs = logs.filter((l) => l.eventName === "ExitOwed" && l.address === ex.address && l.logIndex < ex.logIndex);
  const x = ex.args as { member: Address; to: Address; shares: bigint; assets: Address[]; amounts: bigint[] };
  const to = getAddress(x.to);
  const assets = await Promise.all(
    x.assets.map(async (a, i) => {
      const amount = BigInt(x.amounts[i] ?? 0n);
      const setAside = owedLogs.filter((o) => (o.args.asset as string).toLowerCase() === a.toLowerCase()).reduce((s, o) => s + BigInt(o.args.amount as bigint), 0n);
      const t = await d.token(getAddress(a));
      return { asset: getAddress(a), symbol: t?.symbol ?? null, decimals: t?.decimals ?? null, amount, sent: amount - setAside, setAside };
    }),
  );
  const before = r.blockNumber - 1n;
  const pot = ex.address;
  const checks: CheckLine[] = [
    { what: "The Exited log (and any ExitOwed log) in this transaction", command: `cast receipt ${r.transactionHash} --rpc-url ${d.rpcUrl}` },
    { what: "Total shares just before the exit (each amount = distributable x shares burned / this, rounded down)", command: castCall(d.rpcUrl, pot, "totalShares()(uint256)", [], before) },
  ];
  for (const a of assets) {
    if (a.amount === 0n) continue;
    const name = a.symbol ?? a.asset;
    checks.push({ what: `${name}: distributable just before the exit`, command: castCall(d.rpcUrl, pot, "distributable(address)(uint256)", [a.asset], before) });
    checks.push({ what: `${name}: the destination's balance before (block ${before}); compare with the next line, the difference is the amount sent`, command: castCall(d.rpcUrl, a.asset, "balanceOf(address)(uint256)", [to], before) });
    checks.push({ what: `${name}: the destination's balance after (block ${r.blockNumber})`, command: castCall(d.rpcUrl, a.asset, "balanceOf(address)(uint256)", [to], r.blockNumber) });
    if (a.setAside > 0n) checks.push({ what: `${name}: set aside for the destination right after the exit`, command: castCall(d.rpcUrl, pot, "owed(address,address)(uint256)", [a.asset, to], r.blockNumber) });
  }
  return { kind: "exit", chainId: d.chainId, tx: r.transactionHash, block: r.blockNumber, pot, member: getAddress(x.member), to, sharesBurned: BigInt(x.shares), assets, checks };
}
