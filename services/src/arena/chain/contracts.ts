/**
 * The Arena contracts per chain: addresses (from contracts/deployments/<chain>-arena.json, checked equal by a test)
 * and ABIs (exported from the Foundry build by scripts/arena-abi.ts). Mainnet has none until its deploy, so every
 * Arena process refuses to start there: group accounts never see any of this.
 */
import type { Abi, Address } from "viem";
import factoryAbi from "./abi/TableFactory.json";
import escrowAbi from "./abi/TableEscrow.json";
import registryAbi from "./abi/ResultRegistry.json";
import vaultAbi from "./abi/PrizeVault.json";
import poolAbi from "./abi/StakePool.json";

export interface ArenaContracts {
  chainId: number;
  usdg: Address;
  cofr: Address;
  registry: Address;
  escrowImplementation: Address;
  factory: Address;
  stakePool: Address;
  prizeVault: Address;
  /** First block worth indexing (the deploy block, or a little before it). */
  startBlock: bigint;
  explorer: string;
}

export const ARENA_DEPLOYMENTS: Record<number, ArenaContracts> = {
  46630: {
    chainId: 46630,
    usdg: "0x14119629e364A53ceda500d0c1111DBB136A7398",
    cofr: "0x85497eACbd38DC1E8314ee44605B0E3c4db3015D",
    registry: "0xaE258c10f0Dbc60fa1ED87C12ff4Ae56199D6DD1",
    escrowImplementation: "0xec395B39F0D8BcAe921fd82a3FAa81ff82f8De64",
    factory: "0x5824FAa7889530de7695C9A73Ea08A15683B0651",
    stakePool: "0xF11FDaF085364D72C0c0A14e676690B225d9b916",
    prizeVault: "0x4A9047016ce4FD24ce5045739b700c1E3d809300",
    startBlock: 155_753_800n, // just before the deploy (first deploy tx in block 155,753,810)
    explorer: "https://explorer.testnet.chain.robinhood.com",
  },
};

/** The Arena contracts on this chain, or null (mainnet before its deploy, any other chain). */
export function arenaContracts(chainId: number): ArenaContracts | null {
  return ARENA_DEPLOYMENTS[chainId] ?? null;
}

export const ARENA_ABI = {
  factory: factoryAbi as Abi,
  escrow: escrowAbi as Abi,
  registry: registryAbi as Abi,
  vault: vaultAbi as Abi,
  pool: poolAbi as Abi,
};

/** On-chain TableEscrow.State order. */
export const ESCROW_STATE = ["Open", "Locked", "Settling", "Disputed", "Settled", "Refunded"] as const;
export const ESCROW_MODE = ["FRIEND", "FREEROLL"] as const;
