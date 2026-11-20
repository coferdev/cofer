/** The read-only command line (sdk/bin/cofer.ts) against the real API server on fake data, and a fake chain. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import recorded from "./fixtures/tx-receipts-46630.json";
import { main } from "../../sdk/bin/cofer";
import { POT, POT_MEMBERS, publicServer } from "./publicApiHarness";

let server: ReturnType<typeof Bun.serve>;
let api = "";
beforeAll(() => {
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: publicServer().fetch });
  api = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

async function run(args: string[], chain?: unknown) {
  const lines: string[] = [];
  const code = await main(args, { out: (s) => lines.push(s), chain: chain as never, env: {} });
  return { code, lines };
}

describe("cofer command line", () => {
  test("cofer pot", async () => {
    const r = await run(["pot", POT, "--api", api]);
    expect(r.code).toBe(0);
    expect(r.lines.slice(0, 3)).toEqual([`Group account ${POT}`, "Members: 3. A vote needs 2 approval(s) now (60% of members, rounded up).", "Exit window: 6 h. Deposits open."]);
    expect(r.lines).toContain("  25 USDG  (0x14119629e364A53ceda500d0c1111DBB136A7398)");
  });

  test("cofer member", async () => {
    const r = await run(["member", POT_MEMBERS[1]!, "--api", api]);
    expect(r.lines[0]).toBe(`${POT_MEMBERS[1]} is an active member of 2 group(s):`);
    expect((await run(["member", "0x00000000000000000000000000000000000000e1", "--api", api])).lines[0]).toContain("is not an active member of any group.");
  });

  test("cofer tx", async () => {
    const r = await run(["tx", recorded.kinds.Deposited, "--api", api]);
    expect(r.lines[0]).toContain("A Cofer deposit:");
  });

  test("cofer exit-check reads the chain: shares, the preview and the call", async () => {
    const chain = { readContract: async (a: { functionName: string }) => (a.functionName === "memberInfo" ? { active: true, shares: 10n ** 18n } : [["0x14119629e364A53ceda500d0c1111DBB136A7398"], [1_000_000n]]) };
    const r = await run(["exit-check", POT, POT_MEMBERS[0]!], chain);
    expect(r.lines[0]).toBe(`${POT_MEMBERS[0]} holds 1 shares in ${POT}. Exiting all of them now would pay, in kind:`);
    expect(r.lines[1]).toBe("  1000000 raw units of 0x14119629e364A53ceda500d0c1111DBB136A7398");
    expect(r.lines[2]).toMatch(/^The call \(sent by that member's own key account\): to 0x362B.* data 0xcff40759/);
  });

  test("plain refusals: no API given, a bad address, an unknown command", async () => {
    expect((await run(["pot", POT])).lines[0]).toBe("Give the signer site with --api https://<signer site> (or set COFER_API).");
    expect((await run(["pot", "abc", "--api", api])).lines[0]).toBe("The group must be an address (0x followed by 40 hex characters).");
    expect((await run(["send"])).code).toBe(2);
  });

  test("no command can sign or send: the tool holds no key and calls nothing that writes", () => {
    const files = [join(import.meta.dir, "../../sdk/bin/cofer.ts"), ...readdirSync(join(import.meta.dir, "../../sdk/src")).map((f) => join(import.meta.dir, "../../sdk/src", f))];
    for (const f of files) expect(readFileSync(f, "utf8"), f).not.toMatch(/writeContract|sendTransaction|sendRawTransaction|signTypedData|signMessage|privateKeyToAccount|mnemonicToAccount|createWalletClient/);
  });
});
