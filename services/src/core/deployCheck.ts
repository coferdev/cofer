/**
 * Post-deploy check: proves what is live matches the audited build and the documented roles and
 * settings. READ-ONLY: it reads code and calls view functions (and simulates one call that must
 * revert); it never signs or sends anything. The chain is reached through an injected reader, so the
 * logic is tested without a network (test/deployCheck.test.ts). The CLI is scripts/check-deploy.ts.
 */
import { BaseError, ContractFunctionRevertedError, isAddress, zeroAddress, type Abi, type Address, type Hex } from "viem";
import { coferFactoryAbi, coferPotAbi, feeRouterAbi } from "../chain/abi";

export interface Manifest {
  chainId: number;
  contracts: { factory: string; feeRouter: string; implementation: string; adapter: string };
  expected: {
    owner: string;
    safe: { threshold: number; owners: number };
    guardian: string;
    sinks: [string, string, string, string];
    sinkBps: [number, number, number, number];
    usdg: string;
    swapRouter: string;
    swapFeeBps: number;
    planPricePerMonth: string; // USDG base units (6 dp), as a string
    depositsPaused: boolean;
    creationPaused: boolean;
    assets: { address: string; feed: string; maxStaleness: number; buyable: boolean; isStock: boolean }[];
  };
}

/** Foundry artifact: deployedBytecode.object and its immutableReferences (byte offsets). */
export interface Artifact {
  object: Hex;
  immutableReferences: Record<string, { start: number; length: number }[]>;
}

export interface ChainReader {
  chainId(): Promise<number>;
  code(address: Address): Promise<Hex | undefined>;
  read(address: Address, abi: Abi, functionName: string, args?: readonly unknown[]): Promise<unknown>;
  /** Simulates a call; returns the revert error name, "reverted" for an unnamed revert, or null if it would succeed. */
  revertName(address: Address, abi: Abi, functionName: string, args: readonly unknown[]): Promise<string | null>;
}

export interface CheckResult {
  ok: boolean;
  name: string;
  detail: string;
}

export const SAFE_ABI = [
  { type: "function", name: "getThreshold", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getOwners", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] },
] as const satisfies Abi;

export const ADAPTER_ABI = [{ type: "function", name: "router", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const satisfies Abi;

/** Every address field that is missing, malformed, the zero address, or still a placeholder. */
export function manifestProblems(m: Manifest): string[] {
  const out: string[] = [];
  const addr = (path: string, v: unknown) => {
    if (typeof v !== "string" || !isAddress(v) || v.toLowerCase() === zeroAddress) out.push(`${path} is not a filled-in address (${String(v)})`);
  };
  if (!Number.isInteger(m.chainId)) out.push("chainId is missing");
  for (const [k, v] of Object.entries(m.contracts ?? {})) addr(`contracts.${k}`, v);
  const e = m.expected ?? ({} as Manifest["expected"]);
  addr("expected.owner", e.owner);
  addr("expected.guardian", e.guardian);
  addr("expected.usdg", e.usdg);
  addr("expected.swapRouter", e.swapRouter);
  (e.sinks ?? []).forEach((s, i) => addr(`expected.sinks[${i}]`, s));
  if ((e.sinks ?? []).length !== 4 || (e.sinkBps ?? []).length !== 4) out.push("expected.sinks and expected.sinkBps need 4 entries each");
  (e.assets ?? []).forEach((a, i) => {
    addr(`expected.assets[${i}].address`, a.address);
    addr(`expected.assets[${i}].feed`, a.feed);
  });
  if (!/^\d+$/.test(String(e.planPricePerMonth))) out.push("expected.planPricePerMonth must be a whole number of USDG base units");
  return out;
}

/** Zeroes the byte ranges that hold immutables (set at deploy time), so code can be compared. */
export function maskImmutables(code: Hex, refs: Artifact["immutableReferences"]): string {
  const hex = code.toLowerCase().replace(/^0x/, "").split("");
  for (const ranges of Object.values(refs)) {
    for (const { start, length } of ranges) for (let i = start * 2; i < (start + length) * 2 && i < hex.length; i++) hex[i] = "0";
  }
  return hex.join("");
}

export function codeMatches(onchain: Hex | undefined, artifact: Artifact): boolean {
  if (!onchain || onchain === "0x") return false;
  const a = maskImmutables(artifact.object, artifact.immutableReferences);
  const b = maskImmutables(onchain, artifact.immutableReferences);
  return a.length === b.length && a === b;
}

const same = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();

/** Runs every check. Never throws on a mismatch or a failed read: each becomes a FAIL line. */
export async function runDeployChecks(r: ChainReader, m: Manifest, artifacts: Record<keyof Manifest["contracts"], Artifact>): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const c = m.contracts as Record<keyof Manifest["contracts"], Address>;
  const e = m.expected;
  const check = async (name: string, f: () => Promise<{ ok: boolean; detail: string }>) => {
    try {
      out.push({ name, ...(await f()) });
    } catch (err) {
      const first = err instanceof Error ? err.message.split("\n")[0]! : String(err);
      out.push({ name, ok: false, detail: `could not read: ${first.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>")}` }); // never print an RPC address
    }
  };
  const eq = (name: string, read: () => Promise<unknown>, want: unknown) =>
    check(name, async () => {
      const got = await read();
      return { ok: same(got, want), detail: `got ${String(got)}, expected ${String(want)}` };
    });
  const rd = (a: Address, abi: Abi, fn: string, args?: readonly unknown[]) => r.read(a, abi, fn, args);

  await eq("chain id", () => r.chainId(), m.chainId);

  // 1. code is the audited build (immutables masked)
  for (const k of ["implementation", "factory", "feeRouter", "adapter"] as const) {
    await check(`code: ${k} matches the local build`, async () => {
      const ok = codeMatches(await r.code(c[k]), artifacts[k]);
      return { ok, detail: ok ? "runtime bytecode identical outside immutables" : "runtime bytecode differs from contracts/out (wrong build, wrong commit, or wrong address)" };
    });
  }

  // 2. wiring
  await eq("factory.implementation", () => rd(c.factory, coferFactoryAbi, "implementation"), c.implementation);
  await eq("factory.usdg", () => rd(c.factory, coferFactoryAbi, "usdg"), e.usdg);
  await eq("factory.feeRouter", () => rd(c.factory, coferFactoryAbi, "feeRouter"), c.feeRouter);
  await eq("feeRouter.factory", () => rd(c.feeRouter, feeRouterAbi, "factory"), c.factory);
  await eq("feeRouter.usdg", () => rd(c.feeRouter, feeRouterAbi, "usdg"), e.usdg);
  await eq("adapter.router (SwapRouter02)", () => rd(c.adapter, ADAPTER_ABI, "router"), e.swapRouter);
  await check("implementation refuses initialize (locked)", async () => {
    const name = await r.revertName(c.implementation, coferPotAbi, "initialize", [e.usdg, [e.owner], 1, 0, { guardDelay: 0, maxSlipBps: 0, entrySpreadBps: 0, depositsOpen: false }]);
    return { ok: name === "AlreadyInitialized", detail: name === null ? "initialize would SUCCEED: the implementation is not locked" : `reverts with ${name}` };
  });

  // 3. roles
  await eq("factory.owner is the Safe", () => rd(c.factory, coferFactoryAbi, "owner"), e.owner);
  await eq("factory.pendingOwner is empty", () => rd(c.factory, coferFactoryAbi, "pendingOwner"), zeroAddress);
  await eq("factory.guardian", () => rd(c.factory, coferFactoryAbi, "guardian"), e.guardian);
  await eq("feeRouter.owner is the Safe", () => rd(c.feeRouter, feeRouterAbi, "owner"), e.owner);
  await eq("feeRouter.pendingOwner is empty", () => rd(c.feeRouter, feeRouterAbi, "pendingOwner"), zeroAddress);
  await eq("Safe threshold", async () => Number(await rd(e.owner as Address, SAFE_ABI, "getThreshold")), e.safe.threshold);
  await eq("Safe owner count", async () => ((await rd(e.owner as Address, SAFE_ABI, "getOwners")) as unknown[]).length, e.safe.owners);
  for (let i = 0; i < 4; i++) {
    await eq(`feeRouter.sinks[${i}]`, () => rd(c.feeRouter, feeRouterAbi, "sinks", [BigInt(i)]), e.sinks[i]);
    await eq(`feeRouter.bps[${i}]`, async () => Number(await rd(c.feeRouter, feeRouterAbi, "bps", [BigInt(i)])), e.sinkBps[i]);
  }

  // 4. settings
  await eq("factory.swapFeeBps", async () => Number(await rd(c.factory, coferFactoryAbi, "swapFeeBps")), e.swapFeeBps);
  await eq("feeRouter.planPricePerMonth", async () => String(await rd(c.feeRouter, feeRouterAbi, "planPricePerMonth")), e.planPricePerMonth);
  await eq("factory.depositsPaused", () => rd(c.factory, coferFactoryAbi, "depositsPaused"), e.depositsPaused);
  await eq("factory.creationPaused", () => rd(c.factory, coferFactoryAbi, "creationPaused"), e.creationPaused);
  await eq("factory.isAdapter(adapter)", () => rd(c.factory, coferFactoryAbi, "isAdapter", [c.adapter]), true);
  for (const a of e.assets) {
    await check(`asset ${a.address}`, async () => {
      const info = (await rd(c.factory, coferFactoryAbi, "assetInfo", [a.address])) as {
        listed: boolean;
        buyable: boolean;
        isStock: boolean;
        maxStaleness: number;
        feed: string;
      };
      const diffs: string[] = [];
      if (!info.listed) diffs.push("not listed");
      if (!same(info.feed, a.feed)) diffs.push(`feed ${info.feed} != ${a.feed}`);
      if (Number(info.maxStaleness) !== a.maxStaleness) diffs.push(`maxStaleness ${info.maxStaleness} != ${a.maxStaleness}`);
      if (info.buyable !== a.buyable) diffs.push(`buyable ${info.buyable} != ${a.buyable}`);
      if (info.isStock !== a.isStock) diffs.push(`isStock ${info.isStock} != ${a.isStock}`);
      return { ok: diffs.length === 0, detail: diffs.length ? diffs.join("; ") : "listed with the expected feed and flags" };
    });
  }
  return out;
}

/** Revert name from a viem simulation error (for the real ChainReader). */
export function revertNameOf(e: unknown): string {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) return r.data?.errorName ?? "reverted";
  }
  return "reverted";
}
