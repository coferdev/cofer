/**
 * The SDK's exit kit (sdk/src/exit.ts) against the services' own code:
 *   - its destination refusals equal the signer page's (core/exitDestination.ts) for every case;
 *   - its call runs inside the real CoferPot code (in-process EVM) and reaches exit() itself: the pot answers with
 *     exit's own refusals (ZeroAmount, BadParam) or, with a real call, that the sender holds too few shares in this
 *     empty test pot. A wrong selector or argument layout would fail differently.
 */
import { describe, expect, test } from "bun:test";
import { createEVM } from "@ethereumjs/evm";
import { Common, Hardfork, Mainnet } from "@ethereumjs/common";
import { createAddressFromString, hexToBytes, bytesToHex } from "@ethereumjs/util";
import { decodeErrorResult, encodeFunctionData, type Address, type Hex } from "viem";
import code from "../src/chain/abi/CoferPot.bytecode.json";
import { potAbi } from "../src/chain/clients";
import { destinationProblem as pageCheck, type BlockedAddresses } from "../src/core/exitDestination";
import { buildExit, destinationProblem as sdkCheck } from "../../sdk/src";

const POT = "0x000000000000000000000000000000000000c0fe" as Address;
const KEY = "0xD6D8195a52Fa752A5bBaf76b598336FecAc9c585";

async function runOnPot(data: Hex): Promise<string> {
  const common = new Common({ chain: { ...Mainnet, chainId: 4663 } as typeof Mainnet, hardfork: Hardfork.Cancun });
  const evm = await createEVM({ common });
  await evm.stateManager.putCode(createAddressFromString(POT), hexToBytes(code.deployedBytecode as Hex));
  const r = await evm.runCall({ to: createAddressFromString(POT), caller: createAddressFromString(KEY), data: hexToBytes(data), gasLimit: 1_000_000n });
  if (!r.execResult.exceptionError) return "ok";
  return decodeErrorResult({ abi: potAbi, data: bytesToHex(r.execResult.returnValue) as Hex }).errorName;
}

describe("SDK exit kit", () => {
  test("refuses exactly what the signer page refuses, with the same words", () => {
    const b: BlockedAddresses = {
      pot: POT,
      factory: "0x5d03d53A5630ceCC545Be46635779094A11E47D7",
      feeRouter: "0x3a90EC4e5107BC2e86ACC1a4d576A2daE1478527",
      adapters: ["0x88A44903842fB76C83Ba1569E0F546BB32ffE817"],
      usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
      stockTokens: ["0x322F0929c4625eD5bAd873c95208D54E1c003b2d"],
    };
    const cases = ["", "  ", "0x123", "0xd6d8195a52fa752a5bbaf76b598336fecac9c58", "0xD6D8195a52Fa752A5bBaf76b598336FecAc9c586", "0x0000000000000000000000000000000000000000", POT, POT.toUpperCase().replace("0X", "0x"), b.factory!, b.feeRouter!, b.adapters[0]!, b.usdg, b.stockTokens[0]!, KEY, KEY.toLowerCase(), ` ${KEY} `];
    for (const c of cases) expect(sdkCheck(c, b)).toBe(pageCheck(c, b));
  });

  test("the exit call reaches CoferPot.exit itself", async () => {
    const k = await buildExit({ pot: POT, shares: 10n ** 18n, to: KEY });
    expect(await runOnPot(k.call!.data)).toBe("InsufficientShares"); // exit's own share check, in an empty test pot
    expect(await runOnPot(encodeFunctionData({ abi: potAbi, functionName: "exit", args: [0n, KEY] }))).toBe("ZeroAmount");
    expect(await runOnPot(encodeFunctionData({ abi: potAbi, functionName: "exit", args: [1n, "0x0000000000000000000000000000000000000000"] }))).toBe("BadParam");
    expect(k.call!.data).toBe(encodeFunctionData({ abi: potAbi, functionName: "exit", args: [10n ** 18n, KEY] }));
  });
});
