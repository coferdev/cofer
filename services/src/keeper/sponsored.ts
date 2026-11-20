/**
 * The sponsored actions ledger (table sponsored_ops): every member action sent through the EntryPoint (a
 * UserOperationEvent whose sender is a member key), with the paymaster that covered its network fee (zero address =
 * the account paid itself), the gas used, the cost in wei, whether it went through, and its UTC day. Read from the
 * chain's EntryPoint logs only (no paymaster provider data); only known member accounts are kept.
 * Keeper job, every minute, in block ranges from its saved position.
 */
import { decodeEventLog, parseAbi, type Address, type Hex } from "viem";

export const SPONSORED = "ledger:sponsored_ops";
export const USER_OP_EVENT = parseAbi(["event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)"]);
export const RANGE_BLOCKS = 20_000n;
export const RANGES_PER_RUN = 30;
const ZERO = "0x0000000000000000000000000000000000000000";

export interface UserOpRow {
  userOpHash: string;
  sender: string;
  paymaster: string;
  sponsored: boolean;
  success: boolean;
  gasUsed: bigint;
  costWei: bigint;
  block: bigint;
  day: string;
  tx: string;
}

export interface RawLog {
  address: string;
  topics: readonly Hex[];
  data: Hex;
  blockNumber: bigint;
  transactionHash: string;
}

/** Rows for the logs whose sender is a member account (others are left out). */
export function userOpRows(logs: RawLog[], entryPoint: string, members: Set<string>, dayOf: (block: bigint) => string): UserOpRow[] {
  const out: UserOpRow[] = [];
  for (const l of logs) {
    if (l.address.toLowerCase() !== entryPoint.toLowerCase()) continue;
    let e;
    try {
      e = decodeEventLog({ abi: USER_OP_EVENT, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
    } catch {
      continue;
    }
    const a = e.args;
    if (!members.has(a.sender.toLowerCase())) continue;
    out.push({ userOpHash: a.userOpHash, sender: a.sender, paymaster: a.paymaster, sponsored: a.paymaster.toLowerCase() !== ZERO, success: a.success, gasUsed: a.actualGasUsed, costWei: a.actualGasCost, block: l.blockNumber, day: dayOf(l.blockNumber), tx: l.transactionHash });
  }
  return out;
}

export interface SponsoredDeps {
  entryPoint: Address;
  members(): Promise<string[]>;
  head(): Promise<bigint>;
  startBlock: bigint;
  cursor(): Promise<bigint | null>; // the last block done
  /** EntryPoint UserOperationEvent logs for these senders in [from, to]. */
  logs(from: bigint, to: bigint, senders: Address[]): Promise<RawLog[]>;
  blockTime(n: bigint): Promise<number>;
  save(rows: UserOpRow[], lastBlock: bigint): Promise<void>; // rows and the new position, together
}

/** Brings the ledger forward by up to RANGES_PER_RUN block ranges. */
export async function syncSponsored(d: SponsoredDeps): Promise<{ from: bigint; to: bigint; rows: number } | null> {
  const members = (await d.members()).map((m) => m.toLowerCase());
  const head = await d.head();
  const start = ((await d.cursor()) ?? d.startBlock - 1n) + 1n;
  if (start > head) return null;
  let from = start;
  let rows = 0;
  for (let i = 0; i < RANGES_PER_RUN && from <= head; i++) {
    const to = from + RANGE_BLOCKS - 1n > head ? head : from + RANGE_BLOCKS - 1n;
    const logs: RawLog[] = [];
    for (let k = 0; k < members.length; k += 50) logs.push(...(await d.logs(from, to, members.slice(k, k + 50) as Address[])));
    const times = new Map<bigint, string>();
    for (const l of logs) if (!times.has(l.blockNumber)) times.set(l.blockNumber, new Date((await d.blockTime(l.blockNumber)) * 1000).toISOString().slice(0, 10));
    const r = userOpRows(logs, d.entryPoint, new Set(members), (b) => times.get(b)!);
    await d.save(r, to);
    rows += r.length;
    from = to + 1n;
  }
  return { from: start, to: from - 1n, rows };
}
