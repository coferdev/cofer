/**
 * Every call shape the signer page sends with a passkey, encoded by the real Kernel account
 * (account.encodeCalls from the installed library, set up as in services/src/web/client.ts),
 * must pass the page's check callDataCarries. The low-level encoder alone is not enough:
 * account.encodeCalls sends one call to the account itself unwrapped (key setup: "0x").
 * Throwaway key, no network: the only request answered is the chain ID, locally.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { createPublicClient, custom, encodeFunctionData, getAddress, keccak256, toHex, type Address, type Hex } from "viem";
import { createKernelAccount } from "@zerodev/sdk";
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";
import { toPasskeyValidator, PasskeyValidatorContractVersion } from "@zerodev/passkey-validator";
import { coferPotAbi } from "../src/chain/abi";
import { callDataCarries, exitCalls } from "../src/core/signCheck";

const A = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`) as Address;
const ACCOUNT = A(0xa11ce); // the member's smart account (fixed, so no address lookup is needed)
const POT = A(0xa1);
const USDG = A(0x05d6);
const STOCK = A(0x5701);
const RECIPIENT = A(0xb0b);
const AMOUNT = 25_000_000n;

const chain = { id: 46630, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["http://127.0.0.1:1"] } } } as const;
let networkRequests = 0;
const publicClient = createPublicClient({
  chain,
  transport: custom({
    request: async ({ method }: { method: string }) => {
      if (method === "eth_chainId") return toHex(chain.id);
      networkRequests++;
      throw new Error(`no network in this test: ${method}`);
    },
  }),
});

let account: Awaited<ReturnType<typeof createKernelAccount>>;

beforeAll(async () => {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" }); // throwaway P-256 key
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const big = (s: string) => BigInt(`0x${Buffer.from(s, "base64url").toString("hex")}`);
  const entryPoint = getEntryPoint("0.7");
  const validator = await toPasskeyValidator(publicClient, {
    webAuthnKey: { pubX: big(jwk.x), pubY: big(jwk.y), authenticatorId: "test", authenticatorIdHash: keccak256(toHex("test")), rpID: "test.example" },
    entryPoint,
    kernelVersion: KERNEL_V3_1,
    validatorContractVersion: PasskeyValidatorContractVersion.V0_0_3_PATCHED,
  });
  account = await createKernelAccount(publicClient, { plugins: { sudo: validator }, entryPoint, kernelVersion: KERNEL_V3_1, address: ACCOUNT });
});

const approveAbi = [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }] as const;

// the calls exactly as services/src/web/client.ts builds them
const shapes: [string, () => { to: Address; data: Hex }[]][] = [
  ["key setup (one empty call to the account itself)", () => [{ to: ACCOUNT, data: "0x" }]],
  ["deposit (approve + deposit batch)", () => [
    { to: USDG, data: encodeFunctionData({ abi: approveAbi, args: [POT, AMOUNT] }) },
    { to: POT, data: encodeFunctionData({ abi: coferPotAbi, functionName: "deposit", args: [AMOUNT] }) },
  ]],
  ["exit (own key)", () => exitCalls({ kind: "exit", pot: POT, shares: 123_456n, to: ACCOUNT, own: true })],
  ["spend", () => [{ to: POT, data: encodeFunctionData({ abi: coferPotAbi, functionName: "spend", args: [RECIPIENT, AMOUNT, `0x${"00".repeat(32)}`] }) }]],
  ["claim", () => [{ to: POT, data: encodeFunctionData({ abi: coferPotAbi, functionName: "claimOwed", args: [STOCK, ACCOUNT] }) }]],
];

describe("every passkey call shape, encoded by the real Kernel account, passes the page's check", () => {
  for (const [name, build] of shapes) {
    test(name, async () => {
      const calls = build();
      const callData = (await account.encodeCalls(calls.map((c) => ({ ...c, value: 0n })))) as Hex;
      expect(account.address).toBe(ACCOUNT);
      expect(callDataCarries(callData, calls, account.address)).toBe(true);
    });
  }

  test("key setup is encoded unwrapped as empty call data, which the old substring check refused", async () => {
    const callData = (await account.encodeCalls([{ to: ACCOUNT, value: 0n, data: "0x" }])) as Hex;
    expect(callData).toBe("0x");
    expect(callDataCarries(callData, [{ to: ACCOUNT, data: "0x" }])).toBe(false); // without the account: the old behaviour
  });

  test("a changed call is still refused", async () => {
    const calls = [{ to: POT, data: encodeFunctionData({ abi: coferPotAbi, functionName: "spend", args: [RECIPIENT, AMOUNT, `0x${"00".repeat(32)}`] }) }];
    const other = [{ to: POT, data: encodeFunctionData({ abi: coferPotAbi, functionName: "spend", args: [STOCK, AMOUNT, `0x${"00".repeat(32)}`] }) }];
    const callData = (await account.encodeCalls(other.map((c) => ({ ...c, value: 0n })))) as Hex;
    expect(callDataCarries(callData, calls, account.address)).toBe(false);
  });

  test("no network was used", () => {
    expect(networkRequests).toBe(0);
  });
});
