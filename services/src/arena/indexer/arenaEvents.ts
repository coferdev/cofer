/**
 * Arena chain events → projection steps (spec §5.1 indexer). Pure: a log and its block time in, one step out.
 * TableFactory (TableCreated + admin), every TableEscrow clone, ResultRegistry, PrizeVault and StakePool.
 * The chain is always the source of truth; these steps only keep the arena_* tables in step with it.
 */
import { type Abi, type Address, type Hex, type Log, decodeEventLog, getAddress } from "viem";
import { ARENA_ABI, ESCROW_MODE } from "../chain/contracts";

export type Source = "factory" | "escrow" | "registry" | "vault" | "pool";

export type ArenaStep =
  | { op: "table-created"; table: Address; host: Address; mode: (typeof ESCROW_MODE)[number]; signerSetId: number; rulesHash: Hex }
  | { op: "joined"; table: Address; player: Address; seat: number; sessionKeyHash: Hex; prizeEligible: boolean }
  | { op: "left"; table: Address; player: Address }
  | { op: "locked"; table: Address; lockedAt: number; endAt: number; hardDeadline: number; pot: bigint }
  | { op: "result-posted"; table: Address; round: number; digest: Hex; disputeEnd: number }
  | { op: "disputed"; table: Address; by: Address; round: number; reasonHash: Hex; bond: bigint }
  | { op: "objection"; table: Address; by: Address; reasonHash: Hex }
  | { op: "settled"; table: Address; digest: Hex; unanimous: boolean }
  | { op: "refunded"; table: Address; reason: number }
  | { op: "cancelled"; table: Address }
  | { op: "claimed"; table: Address; account: Address; to: Address; amount: bigint }
  | { op: "result-recorded"; table: Address; round: number; digest: Hex; logHead: Hex; eventsRoot: Hex; standingsRoot: Hex; logURI: string }
  | { op: "tape-anchored"; hourId: bigint; tapeHead: Hex; uri: string }
  | { op: "funded"; table: Address; token: Address; amount: bigint }
  | { op: "staked"; owner: Address; id: bigint; amount: bigint; term: number; unlockAt: number }
  | { op: "unstaked"; owner: Address; id: bigint; amount: bigint }
  | { op: "pledged"; owner: Address; id: bigint; amount: bigint }
  | { op: "bond-marked"; owner: Address; id: bigint }
  | { op: "bond-extended"; owner: Address; bondUntil: number }
  /** Caps, pause, signer sets, eligibility signer, ownership: recorded, and passed to the role checks. */
  | { op: "admin"; source: Source; address: Address; name: string };

export interface Decoded {
  name: string;
  args: Record<string, unknown>;
  step: ArenaStep;
}

const ABI: Record<Source, Abi> = { factory: ARENA_ABI.factory, escrow: ARENA_ABI.escrow, registry: ARENA_ABI.registry, vault: ARENA_ABI.vault, pool: ARENA_ABI.pool };
const n = (v: unknown) => Number(v as bigint | number);

/** Decodes one log from a known Arena contract. Unknown topics return null (never throw on a log we do not use). */
export function decodeArenaLog(source: Source, log: Pick<Log, "address" | "data" | "topics">): Decoded | null {
  let d: { eventName: string; args: Record<string, unknown> };
  try {
    d = decodeEventLog({ abi: ABI[source], data: log.data, topics: log.topics as [Hex, ...Hex[]] }) as unknown as typeof d;
  } catch {
    return null;
  }
  const a = d.args ?? {};
  const at = getAddress(log.address);
  const step = toStep(source, at, d.eventName, a);
  return { name: d.eventName, args: a, step };
}

function toStep(source: Source, at: Address, name: string, a: Record<string, unknown>): ArenaStep {
  const A = (k: string) => getAddress(a[k] as string);
  if (source === "factory" && name === "TableCreated") {
    return { op: "table-created", table: A("table"), host: A("host"), mode: ESCROW_MODE[n(a.mode)] ?? "FRIEND", signerSetId: n(a.signerSetId), rulesHash: a.rulesHash as Hex };
  }
  if (source === "escrow") {
    switch (name) {
      case "Joined":
        return { op: "joined", table: at, player: A("player"), seat: n(a.seat), sessionKeyHash: a.sessionKeyHash as Hex, prizeEligible: a.prizeEligible as boolean };
      case "Left":
      case "Kicked":
        return { op: "left", table: at, player: A("player") };
      case "Locked":
        return { op: "locked", table: at, lockedAt: n(a.lockedAt), endAt: n(a.endAt), hardDeadline: n(a.hardDeadline), pot: a.pot as bigint };
      case "ResultPosted":
        return { op: "result-posted", table: at, round: n(a.round), digest: a.digest as Hex, disputeEnd: n(a.disputeEnd) };
      case "Disputed":
        return { op: "disputed", table: at, by: A("by"), round: n(a.round), reasonHash: a.reasonHash as Hex, bond: a.bond as bigint };
      case "Objection":
        return { op: "objection", table: at, by: A("by"), reasonHash: a.reasonHash as Hex };
      case "Settled":
        return { op: "settled", table: at, digest: a.digest as Hex, unanimous: a.unanimous as boolean };
      case "Refunded":
        return { op: "refunded", table: at, reason: n(a.reason) };
      case "Cancelled":
        return { op: "cancelled", table: at };
      case "Claimed":
        return { op: "claimed", table: at, account: A("account"), to: A("to"), amount: a.amount as bigint };
    }
  }
  if (source === "registry") {
    if (name === "ResultRecorded")
      return { op: "result-recorded", table: A("table"), round: n(a.round), digest: a.digest as Hex, logHead: a.logHead as Hex, eventsRoot: a.eventsRoot as Hex, standingsRoot: a.standingsRoot as Hex, logURI: a.logURI as string };
    if (name === "TapeAnchored") return { op: "tape-anchored", hourId: a.hourId as bigint, tapeHead: a.tapeHead as Hex, uri: a.tapeURI as string };
  }
  if (source === "vault" && name === "Funded") return { op: "funded", table: A("table"), token: A("token"), amount: a.amount as bigint };
  if (source === "pool") {
    switch (name) {
      case "Staked":
        return { op: "staked", owner: A("owner"), id: a.id as bigint, amount: a.amount as bigint, term: n(a.term), unlockAt: n(a.unlockAt) };
      case "Unstaked":
        return { op: "unstaked", owner: A("owner"), id: a.id as bigint, amount: a.amount as bigint };
      case "Pledged":
        return { op: "pledged", owner: A("owner"), id: a.id as bigint, amount: a.amount as bigint };
      case "BondMarked":
        return { op: "bond-marked", owner: A("owner"), id: a.id as bigint };
      case "BondExtended":
        return { op: "bond-extended", owner: A("owner"), bondUntil: n(a.bondUntil) };
    }
  }
  return { op: "admin", source, address: at, name };
}

/** JSON-safe args for arena_chain_events (bigints as decimal strings). */
export const jsonArgs = (args: Record<string, unknown>) => JSON.parse(JSON.stringify(args, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
