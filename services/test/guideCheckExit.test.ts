/**
 * The exit guide (docs/guides/check-your-exit.md): every command in it must match the group account's contract
 * exactly, so a reader who pastes it gets the answer the guide describes.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { toEventSelector, toFunctionSelector, type AbiEvent, type AbiFunction } from "viem";
import { erc20Abi, potAbi as coferPotAbi } from "../src/chain/clients";

const guide = readFileSync(new URL("../../docs/guides/check-your-exit.md", import.meta.url), "utf8");
const commands = [...guide.matchAll(/```bash\n([\s\S]*?)```/g)].flatMap((m) => m[1]!.trim().split("\n"));
const fns = [...(coferPotAbi as readonly AbiFunction[]), ...(erc20Abi as readonly AbiFunction[])].filter((x) => x.type === "function");

/** "memberInfo(address)((bool,uint256))" -> name, input types, output types. */
function parseSig(sig: string) {
  const m = /^(\w+)\(([^()]*)\)(?:\((.*)\))?$/.exec(sig)!;
  return { name: m[1]!, ins: m[2] ? m[2].split(",") : [], outs: m[3] ?? null };
}
const outType = (o: { type: string; components?: readonly { type: string }[] }): string => (o.type === "tuple" ? `(${o.components!.map(outType).join(",")})` : o.type);

describe("guide: check your own exit", () => {
  test("every cast call reads a real view function with the right inputs and outputs", () => {
    const calls = commands.filter((c) => c.startsWith("cast call "));
    expect(calls.length).toBe(5);
    for (const c of calls) {
      const sig = /"([^"]+)"/.exec(c)![1]!;
      const p = parseSig(sig);
      const fn = fns.find((f) => f.name === p.name && f.inputs.map((i) => i.type).join(",") === p.ins.join(","));
      expect(fn, sig).toBeDefined();
      expect(fn!.stateMutability).toBe("view");
      expect(fn!.outputs.map(outType).join(",")).toBe(p.outs!);
    }
  });

  test("the exit and claim calls are the contract's own functions", () => {
    const calldata = commands.filter((c) => c.startsWith("cast calldata")).map((c) => /"([^"]+)"/.exec(c)![1]!);
    expect(calldata).toEqual(["exit(uint256,address)", "claimOwed(address,address)"]);
    for (const sig of calldata) {
      const fn = fns.find((f) => toFunctionSelector(f) === toFunctionSelector(sig));
      expect(fn?.stateMutability).toBe("nonpayable");
    }
  });

  test("the Exited log filter matches the contract's event exactly, indexed fields included", () => {
    const line = commands.find((c) => c.startsWith("cast logs"))!;
    const sig = /"([^"]+)"/.exec(line)![1]!;
    const ev = (coferPotAbi as readonly AbiEvent[]).find((x) => x.type === "event" && x.name === "Exited")!;
    const fromAbi = `Exited(${ev.inputs.map((i) => `${i.type}${i.indexed ? " indexed" : ""} ${i.name}`).join(",")})`;
    expect(sig).toBe(fromAbi);
    expect(toEventSelector(sig.replace(/ indexed| \w+(?=[,)])/g, ""))).toBe(toEventSelector(ev));
  });

  test("the guide never asks for a key, seed phrase or private key", () => {
    expect(guide).not.toMatch(/private key|seed phrase|--private-key|mnemonic/i);
  });
});
