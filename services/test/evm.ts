/** Runs the compiled CoferPot runtime bytecode in an in-process EVM (chainId 4663, Cancun). */
import { createEVM } from "@ethereumjs/evm";
import { Common, Hardfork, Mainnet } from "@ethereumjs/common";
import { createAddressFromString, hexToBytes, bytesToHex } from "@ethereumjs/util";
import { decodeFunctionResult, encodeFunctionData, type Hex } from "viem";
import code from "../src/chain/abi/CoferPot.bytecode.json";
import { coferPotAbi } from "../src/chain/abi";

export const POT = "0x000000000000000000000000000000000000c0fe" as const;

export async function potEvm(chainId = 4663) {
  const common = new Common({ chain: { ...Mainnet, chainId } as typeof Mainnet, hardfork: Hardfork.Cancun });
  const evm = await createEVM({ common });
  await evm.stateManager.putCode(createAddressFromString(POT), hexToBytes(code.deployedBytecode as Hex));
  return {
    async call<F extends "hashProposal" | "domainSeparator" | "PROPOSAL_TYPEHASH">(functionName: F, args: readonly unknown[] = []) {
      const data = encodeFunctionData({ abi: coferPotAbi, functionName, args } as never);
      const r = await evm.runCall({ to: createAddressFromString(POT), data: hexToBytes(data), gasLimit: 1_000_000n });
      if (r.execResult.exceptionError) throw new Error(String(r.execResult.exceptionError.error));
      return decodeFunctionResult({ abi: coferPotAbi, functionName, data: bytesToHex(r.execResult.returnValue) } as never) as Hex;
    },
  };
}
