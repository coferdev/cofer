/**
 * The timelock guide (docs/guides/check-timelocks.md): every command must match the factory's or the fee router's
 * contract exactly, and the guide's table must match who the contracts let do what.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { AbiEvent, AbiFunction } from "viem";
import { factoryAbi, feeRouterAbi } from "../src/chain/clients";

const guide = readFileSync(new URL("../../docs/guides/check-timelocks.md", import.meta.url), "utf8");
const commands = [...guide.matchAll(/```bash\n([\s\S]*?)```/g)].flatMap((m) => m[1]!.trim().split("\n"));
const abiFor = (c: string) => (c.includes("$ROUTER") ? feeRouterAbi : factoryAbi) as readonly (AbiFunction | AbiEvent)[];
const outType = (o: { type: string; components?: readonly { type: string }[] }): string => (o.type === "tuple" ? `(${o.components!.map(outType).join(",")})` : o.type);

describe("guide: check timelocks yourself", () => {
  test("every cast call reads a real view function with the right inputs and outputs", () => {
    const calls = commands.filter((c) => c.startsWith("cast call "));
    expect(calls.length).toBe(10);
    for (const c of calls) {
      const m = /"(\w+)\(([^()]*)\)\((.*)\)"/.exec(c)!;
      const fn = abiFor(c).find((f) => f.type === "function" && f.name === m[1] && f.inputs.map((i) => i.type).join(",") === (m[2] ?? "")) as AbiFunction | undefined;
      expect(fn, c).toBeDefined();
      expect(fn!.stateMutability).toBe("view");
      expect(fn!.outputs.map(outType).join(",")).toBe(m[3]!);
    }
  });

  test("every log filter matches the factory's event exactly, indexed fields included", () => {
    const logs = commands.filter((c) => c.startsWith("cast logs"));
    expect(logs.length).toBe(3);
    for (const c of logs) {
      const sig = /"([^"]+)"/.exec(c)![1]!;
      const ev = (factoryAbi as readonly AbiEvent[]).find((x) => x.type === "event" && x.name === sig.split("(")[0])!;
      expect(sig).toBe(`${ev.name}(${ev.inputs.map((i) => `${i.type}${i.indexed ? " indexed" : ""} ${i.name}`).join(",")})`);
    }
  });

  test("the timelocked actions are the ones the factory queues, and the at-once ones have no queue", () => {
    const names = (factoryAbi as readonly AbiFunction[]).filter((f) => f.type === "function").map((f) => f.name);
    for (const queued of ["queueFeed", "applyFeed", "queueAdapter", "applyAdapter", "queueSwapFee", "applySwapFee"]) expect(names).toContain(queued);
    expect(names).not.toContain("queueSinks");
    expect(names).not.toContain("queuePlanPrice");
    expect(guide).toContain("**after a 48-hour wait**: change a price feed, turn on a swap adapter, change the swap fee");
    expect(guide).toContain("No pause, vote or price feed can stop `exit()`.");
  });
});
