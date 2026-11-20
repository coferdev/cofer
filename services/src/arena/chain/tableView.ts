/** A table's live state read from chain, in the shape the job plan uses (jobs/plan.ts TableView). */
import type { Address, PublicClient } from "viem";
import { ARENA_ABI } from "./contracts";
import { STATE, type TableView } from "../jobs/plan";

type Reader = Pick<PublicClient, "multicall" | "readContract">;

export async function readTable(client: Reader, table: Address): Promise<TableView> {
  const abi = ARENA_ABI.escrow;
  const call = (functionName: string) => client.readContract({ address: table, abi, functionName });
  const [state, params, seats, endAt, disputeEnd, hardDeadline, result] = await Promise.all([
    call("state"), call("params"), call("seats"), call("endAt"), call("disputeEnd"), call("hardDeadline"), call("currentResult"),
  ]);
  const p = params as { lockAt: bigint; openUntil: bigint; minSeats: number };
  return {
    table,
    state: STATE[Number(state)]!,
    lockAt: Number(p.lockAt),
    openUntil: Number(p.openUntil),
    seats: (seats as readonly string[]).length,
    minSeats: Number(p.minSeats),
    endAt: Number(endAt),
    disputeEnd: Number(disputeEnd),
    hardDeadline: Number(hardDeadline),
    round: Number((result as readonly unknown[])[0]),
  };
}
