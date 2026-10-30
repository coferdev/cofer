import { createPublicClient, createWalletClient, http, type Address, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { robinhood, robinhoodTestnet } from "viem/chains";
import { env } from "../env";
import { coferPotAbi, coferFactoryAbi, feeRouterAbi } from "./abi";

export const potAbi = coferPotAbi;
export const factoryAbi = coferFactoryAbi;
export { feeRouterAbi };

export const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "uiMultiplier", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

export const aggregatorAbi = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { type: "uint80", name: "roundId" },
      { type: "int256", name: "answer" },
      { type: "uint256", name: "startedAt" },
      { type: "uint256", name: "updatedAt" },
      { type: "uint80", name: "answeredInRound" },
    ],
  },
] as const;

export function chain() {
  return env().CHAIN_ID === 46630 ? robinhoodTestnet : robinhood;
}

let _pub: PublicClient | undefined;
export function publicClient(): PublicClient {
  // Never rely on viem's default RPC list for RHC (it includes a third-party endpoint).
  _pub ??= createPublicClient({ chain: chain(), transport: http(env().RHC_RPC_URL, { batch: true, retryCount: 3 }) }) as PublicClient;
  return _pub;
}

export function relayerClient() {
  const account = privateKeyToAccount(env().RELAYER_PRIVATE_KEY as `0x${string}`);
  return createWalletClient({ account, chain: chain(), transport: http(env().RHC_RPC_URL) });
}

export const factoryAddress = () => env().FACTORY_ADDRESS as Address;

/** Refuses to start when USDG_ADDRESS is not the USDG the factory's pots actually hold. */
export async function assertFactoryUsdg(client: Pick<PublicClient, "readContract">, factory: Address, expected: Address) {
  const onChain = await client.readContract({ address: factory, abi: factoryAbi, functionName: "usdg" });
  if (onChain.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`USDG mismatch: factory ${factory} uses ${onChain} but USDG_ADDRESS is ${expected}. Set USDG_ADDRESS to the factory's USDG.`);
  }
}
