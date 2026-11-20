/**
 * The Arena relayer: sends the permissionless escrow calls (lock, cancel, finalize, refundAll) from a gas-only key.
 * Each call is simulated against the latest block first (a call the escrow would refuse is never sent), only one
 * call per table is in flight at a time, and the outcome is known only from the receipt.
 */
import type { Account, Address, Chain, PublicClient, Transport, WalletClient } from "viem";
import { ARENA_ABI } from "../chain/contracts";
import type { RelayCall, RelayOutcome } from "./sweep";

export function makeRelayer(pub: Pick<PublicClient, "simulateContract" | "waitForTransactionReceipt">, wallet: WalletClient<Transport, Chain, Account>, timeoutMs = 60_000) {
  const inFlight = new Set<string>();
  return async function relay(table: Address, call: RelayCall): Promise<RelayOutcome> {
    const key = table.toLowerCase();
    if (inFlight.has(key)) return { sent: false, why: "a call for this table is already in flight" };
    inFlight.add(key);
    try {
      let request: Parameters<typeof wallet.writeContract>[0];
      try {
        ({ request } = (await pub.simulateContract({ address: table, abi: ARENA_ABI.escrow, functionName: call, account: wallet.account })) as unknown as { request: typeof request });
      } catch (e) {
        return { sent: false, why: `the escrow would refuse it: ${shortReason(e)}` };
      }
      const tx = await wallet.writeContract(request);
      const r = await pub.waitForTransactionReceipt({ hash: tx, timeout: timeoutMs });
      return r.status === "success" ? { sent: true, tx } : { sent: false, why: `reverted on chain (${tx})` };
    } finally {
      inFlight.delete(key);
    }
  };
}

export function shortReason(e: unknown): string {
  const m = e as { shortMessage?: string; message?: string; cause?: { data?: { errorName?: string } } };
  return m.cause?.data?.errorName ?? m.shortMessage?.split("\n")[0] ?? m.message?.split("\n")[0] ?? "unknown";
}
