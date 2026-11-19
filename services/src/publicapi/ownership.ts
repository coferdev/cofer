/**
 * GET /v1/proof/ownership: who controls Cofer's contracts and what is switched on, read live from the chain, each
 * value with the exact `cast call` line that reads it again, so anyone can check it without trusting this server.
 *   - factory: owner, pending owner (a two-step hand-over), guardian, both pause flags, the swap fee and any queued fee
 *   - fee router: owner, pending owner, and the four fee wallets with their shares
 * Exits are never paused by anything here: no pause flag reaches exit().
 */
import { getAddress, type Address } from "viem";
import { factoryAbi, feeRouterAbi } from "../chain/clients";

export const OWNERSHIP_CACHE_MS = 60_000;

/** A read of one view function with no input (or one index for sinks/bps). */
export interface OwnershipDeps {
  factory: Address;
  feeRouter(): Promise<Address>;
  rpcUrl: string; // public RPC printed in the cast lines (never the server's own keyed RPC)
  readFactory(fn: string): Promise<unknown>;
  readRouter(router: Address, fn: string, args?: readonly unknown[]): Promise<unknown>;
}

export interface CheckLine {
  what: string;
  value: string;
  command: string;
}

export interface Ownership {
  factory: { address: Address; owner: Address; pendingOwner: Address | null; guardian: Address; depositsPaused: boolean; creationPaused: boolean; swapFeeBps: number; queuedSwapFeeBps: number | null; queuedSwapFeeEta: number | null };
  feeRouter: { address: Address; owner: Address; pendingOwner: Address | null; sinks: { address: Address; bps: number }[] };
  exitsPausable: false;
  checks: CheckLine[];
}

const ZERO = "0x0000000000000000000000000000000000000000";
const orNull = (a: unknown) => (String(a).toLowerCase() === ZERO ? null : getAddress(String(a)));

/** The exact command that reads one value (signature with its output type, as cast expects). */
export function castLine(contract: Address, sig: string, rpcUrl: string, args: (string | number)[] = []): string {
  return `cast call ${contract} "${sig}"${args.map((a) => ` ${a}`).join("")} --rpc-url ${rpcUrl}`;
}

export async function readOwnership(d: OwnershipDeps): Promise<Ownership> {
  const f = d.factory;
  const r = await d.feeRouter();
  const [owner, pending, guardian, dep, cre, fee, qFee, qEta, rOwner, rPending] = await Promise.all([
    d.readFactory("owner"),
    d.readFactory("pendingOwner"),
    d.readFactory("guardian"),
    d.readFactory("depositsPaused"),
    d.readFactory("creationPaused"),
    d.readFactory("swapFeeBps"),
    d.readFactory("pendingSwapFeeBps"),
    d.readFactory("pendingSwapFeeEta"),
    d.readRouter(r, "owner"),
    d.readRouter(r, "pendingOwner"),
  ]);
  const sinks = await Promise.all([0, 1, 2, 3].map(async (i) => ({ address: getAddress(String(await d.readRouter(r, "sinks", [BigInt(i)]))), bps: Number(await d.readRouter(r, "bps", [BigInt(i)])) })));
  const eta = Number(qEta);
  const out: Ownership = {
    factory: {
      address: getAddress(f),
      owner: getAddress(String(owner)),
      pendingOwner: orNull(pending),
      guardian: getAddress(String(guardian)),
      depositsPaused: Boolean(dep),
      creationPaused: Boolean(cre),
      swapFeeBps: Number(fee),
      queuedSwapFeeBps: eta > 0 ? Number(qFee) : null,
      queuedSwapFeeEta: eta > 0 ? eta : null,
    },
    feeRouter: { address: getAddress(r), owner: getAddress(String(rOwner)), pendingOwner: orNull(rPending), sinks },
    exitsPausable: false,
    checks: [],
  };
  const c = (what: string, value: unknown, contract: Address, sig: string, args: (string | number)[] = []) => out.checks.push({ what, value: String(value), command: castLine(contract, sig, d.rpcUrl, args) });
  c("Factory owner", out.factory.owner, f, "owner()(address)");
  c("Factory pending owner (zero = none)", out.factory.pendingOwner ?? ZERO, f, "pendingOwner()(address)");
  c("Factory guardian", out.factory.guardian, f, "guardian()(address)");
  c("Deposits paused", out.factory.depositsPaused, f, "depositsPaused()(bool)");
  c("Group creation paused", out.factory.creationPaused, f, "creationPaused()(bool)");
  c("Swap fee (basis points)", out.factory.swapFeeBps, f, "swapFeeBps()(uint16)");
  c("Queued swap fee (basis points)", Number(qFee), f, "pendingSwapFeeBps()(uint16)");
  c("Queued swap fee can apply after (unix time, 0 = none)", eta, f, "pendingSwapFeeEta()(uint64)");
  c("Fee router", out.feeRouter.address, f, "feeRouter()(address)");
  c("Fee router owner", out.feeRouter.owner, r, "owner()(address)");
  c("Fee router pending owner (zero = none)", out.feeRouter.pendingOwner ?? ZERO, r, "pendingOwner()(address)");
  sinks.forEach((s, i) => {
    c(`Fee wallet ${i + 1}`, s.address, r, "sinks(uint256)(address)", [i]);
    c(`Fee wallet ${i + 1} share (basis points)`, s.bps, r, "bps(uint256)(uint16)", [i]);
  });
  return out;
}

/** Every function the cast lines call, with its inputs and output, must exist as a view function in the contract ABI. */
export function castLineProblems(o: Ownership): string[] {
  const out: string[] = [];
  for (const ch of o.checks) {
    const m = /^cast call (0x[0-9a-fA-F]{40}) "(\w+)\(([^)]*)\)\(([^)]*)\)"/.exec(ch.command);
    if (!m) {
      out.push(`unreadable: ${ch.command}`);
      continue;
    }
    const abi = m[1]!.toLowerCase() === o.factory.address.toLowerCase() ? factoryAbi : feeRouterAbi;
    const fn = (abi as unknown as readonly { type: string; name?: string; stateMutability?: string; inputs?: { type: string }[]; outputs?: { type: string }[] }[]).find((x) => x.type === "function" && x.name === m[2]);
    const ins = m[3] ? m[3].split(",") : [];
    if (!fn || fn.stateMutability !== "view" || (fn.inputs ?? []).map((i) => i.type).join(",") !== ins.join(",") || (fn.outputs ?? []).map((x) => x.type).join(",") !== m[4]) out.push(`${m[2]}(${m[3]})(${m[4]}) does not match the ABI`);
  }
  return out;
}
