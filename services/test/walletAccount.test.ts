import { describe, expect, test } from "bun:test";
import { createPublicClient, custom } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { ECDSA_ROOT_VALIDATOR_ID, walletAccountAddress } from "../src/core/accountKind";
import { RHC } from "../src/chain/addresses";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...p: string[]) => readFileSync(join(import.meta.dir, "..", ...p), "utf8");

// throwaway test keys (never funded, never used on any chain)
const ownerA = privateKeyToAccount(`0x${"11".repeat(32)}`);
const ownerB = privateKeyToAccount(`0x${"22".repeat(32)}`);

/** A chain client that answers only eth_chainId: the address must come from pure math, not the network. */
function offlineClient() {
  const calls: string[] = [];
  const client = createPublicClient({
    chain: { id: 46630, name: "Robinhood Chain Testnet", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["http://offline"] } } },
    transport: custom({
      async request({ method }: { method: string }) {
        calls.push(method);
        if (method === "eth_chainId") return "0xb626";
        throw new Error(`offline: ${method}`);
      },
    }),
  });
  return { client, calls };
}

describe("wallet account address (kernel-ecdsa)", () => {
  test("the SDK uses the verified Kernel v3.1 ECDSA validator", async () => {
    const { client } = offlineClient();
    const v = await signerToEcdsaValidator(client, { signer: ownerA, entryPoint: getEntryPoint("0.7"), kernelVersion: KERNEL_V3_1 });
    expect(v.address).toBe(RHC.ZERODEV_ECDSA_VALIDATOR_KERNEL_3_1);
    expect(ECDSA_ROOT_VALIDATOR_ID).toBe("0x01845ADb2C711129d4f3966735eD98a9F09fC4cE57");
  });

  test("the address matches what the chain itself computes (EntryPoint getSenderAddress, read on 46630 and 4663 on 2026-11-15)", async () => {
    // fixed values from a read-only eth_call on both chains through the SDK's createKernelAccount
    expect(await walletAccountAddress(ownerA.address)).toBe("0x5cD5c2bB15fFBe653015377E62926aFa60D5e0a7");
    expect(await walletAccountAddress(ownerB.address)).toBe("0x71861c2E6740D1c96F4E3421A5D003B087F458aF");
  });

  test("building the account offline needs the chain: the page passes the saved address instead of asking", () => {
    const client = read("src", "web", "client.ts");
    expect(client).toContain("...(linked ? { address: linked } : {})");
  });

  test("stable: the same wallet always gives the same address; a different wallet a different one", async () => {
    const first = await walletAccountAddress(ownerA.address);
    expect(await walletAccountAddress(ownerA.address)).toBe(first);
    expect(await walletAccountAddress(ownerA.address.toLowerCase() as `0x${string}`)).toBe(first);
    expect(await walletAccountAddress(ownerB.address)).not.toBe(first);
    expect(first).not.toBe(ownerA.address); // the saved key is the Kernel account, never the wallet itself
  });
});
