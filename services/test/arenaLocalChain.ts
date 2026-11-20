/**
 * A local Arena chain for end-to-end tests: anvil as chain 46630, a mock USDG, and the real DeployArena script.
 * Skipped (available() is false) when anvil/forge or the contracts build are missing.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Account, type Address, type Chain, type Hex, type PublicClient, type Transport, type WalletClient,
  createPublicClient, createTestClient, createWalletClient, defineChain, encodeAbiParameters, getAddress, http, keccak256, toHex,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { ARENA_ABI, type ArenaContracts } from "../src/arena/chain/contracts";

const CONTRACTS = join(import.meta.dir, "../../contracts");
const which = (b: string) => spawnSync("sh", ["-c", `command -v ${b}`]).status === 0;
export const available = () => which("anvil") && which("forge") && existsSync(join(CONTRACTS, "out/Mocks.sol/MockUSDG.json"));

// anvil's well-known development accounts (public mnemonic; they hold only local test ETH)
const MNEMONIC = "test test test test test test test test test test test junk";
export const acct = (i: number) => mnemonicToAccount(MNEMONIC, { addressIndex: i });
export const keyOf = (i: number): Hex => toHex(acct(i).getHdKey().privateKey!);
// roles: 0 deployer, 1 safe, 2 guardian, 3..5 result signers, 6 eligibility signer, 7 scheduler, 8 relayer, 9+ players
export const ROLE = { deployer: 0, safe: 1, guardian: 2, signer1: 3, signer2: 4, signer3: 5, elig: 6, scheduler: 7, relayer: 8 } as const;

export interface LocalChain {
  rpc: string;
  chain: Chain;
  pub: PublicClient;
  wallet(i: number): WalletClient<Transport, Chain, Account>;
  contracts: ArenaContracts;
  warp(seconds: number): Promise<void>;
  now(): Promise<number>;
  stop(): void;
}

function mockUsdgArtifact(): { abi: unknown[]; bytecode: Hex } {
  const j = JSON.parse(readFileSync(join(CONTRACTS, "out/Mocks.sol/MockUSDG.json"), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object as Hex };
}
export const USDG_ABI = () => mockUsdgArtifact().abi;

export async function startLocalChain(port = 18_545 + Math.floor(Math.random() * 1000)): Promise<LocalChain> {
  const rpc = `http://127.0.0.1:${port}`;
  const anvil: ChildProcess = spawn("anvil", ["--chain-id", "46630", "--port", String(port), "--silent", "--accounts", "16"], { stdio: "ignore" });
  const chain = defineChain({ id: 46630, name: "local 46630", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const pub = createPublicClient({ chain, transport: http(rpc) }) as PublicClient;
  for (let i = 0; ; i++) {
    try {
      await pub.getChainId();
      break;
    } catch {
      if (i > 50) throw new Error("anvil did not start");
      await Bun.sleep(100);
    }
  }
  const test = createTestClient({ chain, mode: "anvil", transport: http(rpc) });
  const wallet = (i: number) => createWalletClient({ account: acct(i), chain, transport: http(rpc) });

  const usdgArt = mockUsdgArtifact();
  const h = await wallet(ROLE.deployer).deployContract({ abi: usdgArt.abi, bytecode: usdgArt.bytecode });
  const usdg = getAddress((await pub.waitForTransactionReceipt({ hash: h })).contractAddress!);

  const bdir = mkdtempSync(join(tmpdir(), "arena-local-broadcast-"));
  const r = spawnSync("forge", ["script", "script/DeployArena.s.sol", "--rpc-url", rpc, "--broadcast", "--json", "--slow"], {
    cwd: CONTRACTS,
    env: {
      ...process.env,
      FOUNDRY_BROADCAST: bdir, FOUNDRY_CACHE_PATH: join(bdir, "cache"),
      DEPLOYER_KEY: keyOf(ROLE.deployer), SAFE: acct(ROLE.safe).address, GUARDIAN: acct(ROLE.guardian).address,
      SIGNER_1: acct(ROLE.signer1).address, SIGNER_2: acct(ROLE.signer2).address, SIGNER_3: acct(ROLE.signer3).address,
      ELIG_SIGNER: acct(ROLE.elig).address, SCHEDULER: acct(ROLE.scheduler).address, USDG: usdg,
    },
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`DeployArena failed: ${r.stderr || r.stdout}`);
  const runs = JSON.parse(readFileSync(join(bdir, "DeployArena.s.sol/46630/run-latest.json"), "utf8"));
  rmSync(bdir, { recursive: true, force: true });
  const made = Object.fromEntries(runs.transactions.filter((t: { transactionType: string }) => t.transactionType === "CREATE").map((t: { contractName: string; contractAddress: string }) => [t.contractName, getAddress(t.contractAddress)]));
  const contracts: ArenaContracts = {
    chainId: 46630, usdg, cofr: made.MockERC20, registry: made.ResultRegistry, escrowImplementation: made.TableEscrow, factory: made.TableFactory,
    stakePool: made.StakePool, prizeVault: made.PrizeVault, startBlock: 0n, explorer: "",
  };
  return {
    rpc, chain, pub, wallet, contracts,
    warp: async (s) => {
      await test.increaseTime({ seconds: s });
      await test.mine({ blocks: 1 });
    },
    now: async () => Number((await pub.getBlock()).timestamp),
    stop: () => anvil.kill(),
  };
}

/** A Friend Table's params (the factory's fixed rules: 24 h minimum, 2 h dispute window, 24 h grace, 20% bond). */
export function friendParams(c: ArenaContracts, o: { lockAt?: number; openUntil?: number; buyIn?: bigint; minSeats?: number; maxSeats?: number; rules?: string }) {
  return {
    mode: 0, token: c.usdg, buyIn: o.buyIn ?? 10_000_000n, prize: 0n, minSeats: o.minSeats ?? 2, maxSeats: o.maxSeats ?? 4,
    lockAt: BigInt(o.lockAt ?? 0), openUntil: BigInt(o.openUntil ?? 0), duration: 86_400, disputeWindow: 7_200, settleGrace: 86_400,
    disputeBondBps: 2_000, payoutBps: [10_000], inviteSigner: "0x0000000000000000000000000000000000000000" as Address,
    rulesHash: keccak256(toHex(o.rules ?? "rules")), cryptoOnly: true,
  };
}

export async function createTable(lc: LocalChain, host: number, p: ReturnType<typeof friendParams>, salt: number): Promise<Address> {
  const w = lc.wallet(host);
  const s = encodeAbiParameters([{ type: "uint256" }], [BigInt(salt)]);
  const { result, request } = await lc.pub.simulateContract({ address: lc.contracts.factory, abi: ARENA_ABI.factory, functionName: "createTable", args: [p, s], account: w.account });
  await lc.pub.waitForTransactionReceipt({ hash: await w.writeContract(request) });
  return getAddress(result as string);
}
