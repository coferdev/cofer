import { describe, expect, test } from "bun:test";
import { decodeFunctionData, type Address } from "viem";
import { buildExit, DEST_TEXT, EXIT_ABI, type Reader } from "../src";

const POT = "0x50F19AdD1EE10AF538C1F8bE5bcbA4011F100115" as Address;
const KEY = "0xD6D8195a52Fa752A5bBaf76b598336FecAc9c585";
const USDG = "0x14119629e364A53ceda500d0c1111DBB136A7398" as Address;
const reader: Reader = { readContract: async () => [[USDG], [90_000_000n]] as const };

describe("buildExit", () => {
  test("the exact exit call, the preview and the explorer steps", async () => {
    const k = await buildExit({ pot: POT, shares: "100000000000000000000", to: KEY }, reader);
    expect(k.refused).toBeNull();
    expect(k.call).toMatchObject({ to: POT, value: "0", function: "exit(uint256,address)", args: { shares: "100000000000000000000", to: KEY } });
    expect(decodeFunctionData({ abi: EXIT_ABI, data: k.call!.data })).toEqual({ functionName: "exit", args: [100_000_000_000_000_000_000n, KEY] });
    expect(k.call!.data.slice(0, 10)).toBe("0xcff40759");
    expect(k.preview).toEqual([{ asset: USDG, amount: "90000000" }]);
    expect(k.steps).toHaveLength(5);
  });

  test("offline: no reader, no preview", async () => {
    expect((await buildExit({ pot: POT, shares: 5n, to: KEY })).preview).toBeNull();
  });

  test("refused destinations and share counts send nothing", async () => {
    expect((await buildExit({ pot: POT, shares: 1n, to: POT })).refused).toBe(DEST_TEXT.pot);
    expect((await buildExit({ pot: POT, shares: 1n, to: "0x0000000000000000000000000000000000000000" })).refused).toBe(DEST_TEXT.zero);
    expect((await buildExit({ pot: POT, shares: 1n, to: "0x123" })).refused).toBe(DEST_TEXT.invalid);
    expect((await buildExit({ pot: POT, shares: 1n, to: KEY, blocked: { adapters: [], stockTokens: [], usdg: KEY as Address } })).refused).toBe(DEST_TEXT.usdg);
    expect((await buildExit({ pot: POT, shares: 0n, to: KEY })).refused).toBe("The share count must be a whole number above 0.");
    expect((await buildExit({ pot: POT, shares: "abc", to: KEY })).call).toBeNull();
  });
});
