/**
 * Post-deploy check (read-only). Compares what is live with the local build and a manifest of
 * expected roles and settings; exits 1 on any mismatch. It never signs or sends anything.
 *
 *   cd contracts && forge build && cd ../services
 *   bun run check-deploy ../contracts/deployments/4663.json            # uses RHC_RPC_URL
 *   bun run check-deploy ../contracts/deployments/4663.json --rpc <url>
 *
 * Start from contracts/deployments/4663.example.json: copy it, fill in every address, and keep the
 * filled-in copy with the deploy record. The RPC address is never printed.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createPublicClient, http, type Abi, type Address } from "viem";
import { manifestProblems, revertNameOf, runDeployChecks, type Artifact, type ChainReader, type Manifest } from "../src/core/deployCheck";

const ARTIFACTS: Record<keyof Manifest["contracts"], string> = {
  implementation: "CoferPot.sol/CoferPot.json",
  factory: "CoferFactory.sol/CoferFactory.json",
  feeRouter: "FeeRouter.sol/FeeRouter.json",
  adapter: "SwapAdapter.sol/UniV3SwapAdapter.json",
};

function usage(msg: string): never {
  console.error(`check-deploy: ${msg}\nUsage: bun run check-deploy <manifest.json> [--rpc <url>] [--out <contracts/out>]`);
  process.exit(2);
}

const args = process.argv.slice(2);
const manifestPath = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--rpc" && args[args.indexOf(a) - 1] !== "--out");
if (!manifestPath) usage("no manifest given");
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const rpc = flag("--rpc") ?? process.env.RHC_RPC_URL;
if (!rpc) usage("no RPC: pass --rpc <url> or set RHC_RPC_URL");
const outDir = resolve(flag("--out") ?? join(dirname(new URL(import.meta.url).pathname), "..", "..", "contracts", "out"));

const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
const problems = manifestProblems(manifest);
if (problems.length) usage(`the manifest is not filled in:\n  - ${problems.join("\n  - ")}`);

const artifacts = {} as Record<keyof Manifest["contracts"], Artifact>;
for (const [k, file] of Object.entries(ARTIFACTS) as [keyof Manifest["contracts"], string][]) {
  try {
    const j = JSON.parse(readFileSync(join(outDir, file), "utf8"));
    artifacts[k] = { object: j.deployedBytecode.object, immutableReferences: j.deployedBytecode.immutableReferences ?? {} };
  } catch {
    usage(`no build artifact ${file} in ${outDir}: run "forge build" in contracts/ first`);
  }
}

const client = createPublicClient({ transport: http(rpc) });
const reader: ChainReader = {
  chainId: () => client.getChainId(),
  code: (address) => client.getCode({ address }),
  read: (address, abi, functionName, a) => client.readContract({ address, abi: abi as Abi, functionName, args: a as unknown[] | undefined }),
  revertName: async (address, abi, functionName, a) => {
    try {
      await client.simulateContract({ address, abi: abi as Abi, functionName, args: a as unknown[], account: "0x000000000000000000000000000000000000c0fe" as Address });
      return null;
    } catch (e) {
      return revertNameOf(e);
    }
  },
};

const results = await runDeployChecks(reader, manifest, artifacts);
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}: ${r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} of ${results.length} checks FAILED.` : `\nAll ${results.length} checks passed.`);
process.exit(failed ? 1 : 0);
