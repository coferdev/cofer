/** The integration guide's examples run against the real API server on fake data (a local port). */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import recorded from "./fixtures/tx-receipts-46630.json";
import { createCoferClient, verifyReceipt, type ChainReader } from "../../sdk/src";
import { main } from "../../sdk/bin/cofer";
import { createServer as mcpServer } from "../../tools/mcp/server";
import { publicServer } from "./publicApiHarness";

const guide = readFileSync(new URL("../../docs/guides/integrate.md", import.meta.url), "utf8");
let server: ReturnType<typeof Bun.serve>;
let base = "";
beforeAll(() => {
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: publicServer().fetch });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));
const local = (s: string) => s.replaceAll("https://<signer site>", base);
const chain: ChainReader = {
  getTransactionReceipt: async ({ hash }) => {
    const r = recorded.receipts.find((x) => x.transactionHash === hash)!;
    return { blockNumber: BigInt(r.blockNumber), status: r.status as "success", logs: r.logs as never };
  },
  readContract: async () => "0x",
  verifyTypedData: async () => true,
};

describe("integration guide", () => {
  test("every URL in it answers (badge, feeds, API, receipts)", async () => {
    const urls = [...guide.matchAll(/https:\/\/<signer site>(\/[^\s)"'`]+)/g)].map((m) => m[1]!).filter((p) => !p.endsWith("/v1/openapi.json") && p !== "/llms.txt");
    expect(urls.length).toBeGreaterThan(6);
    for (const p of new Set(urls)) expect((await fetch(local(`https://<signer site>${p}`))).status, p).toBe(200);
  });

  test("the SDK example works as written", async () => {
    const cofer = createCoferClient({ baseUrl: base });
    const pot = await cofer.pot("0x362B6794E6374b400aA186C1a67AC2c060af2E50");
    expect([pot.memberCount, pot.voteRule.approvalsNeeded]).toEqual([3, 2]);
    expect(guide).toContain("import { createCoferClient, verifyReceipt, predictPotAddress } from \"./sdk/src\";");
  });

  test("every command line example runs", async () => {
    const lines = [...guide.matchAll(/^bun sdk\/bin\/cofer\.ts (.+)$/gm)].map((m) => local(m[1]!).split(" "));
    expect(lines.length).toBe(4);
    const dir = mkdtempSync(join(tmpdir(), "guide-"));
    for (const args of lines) {
      if (args[0] === "verify") {
        const r = await fetch(`${base}/v1/receipts/exit/${recorded.kinds.Exited}`);
        writeFileSync(join(dir, "receipt.json"), await r.text());
        args[1] = join(dir, "receipt.json");
      }
      const out: string[] = [];
      expect(await main(args, { out: (s) => out.push(s), chain: chain as never, env: {} }), args.join(" ")).toBe(0);
      expect(out.length).toBeGreaterThan(0);
    }
  });

  test("the MCP server's tools are the ones it names", async () => {
    const h = mcpServer({ api: base });
    const list = (await h({ jsonrpc: "2.0", id: 1, method: "tools/list" }))!.result as { tools: { name: string }[] };
    for (const t of list.tools) expect(guide).toContain(`\`${t.name}\``);
    const r = (await h({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_status", arguments: {} } }))!.result as { isError: boolean };
    expect(r.isError).toBe(false);
  });

  test("the links it gives exist", () => {
    for (const l of [...guide.matchAll(/\]\((\.\.\/[^)]+)\)/g)].map((m) => m[1]!)) expect(existsSync(new URL(`../../docs/guides/${l}`, import.meta.url)), l).toBe(true);
  });

  test("a receipt from the guide checks out against the chain", async () => {
    const r = await (await fetch(`${base}/v1/receipts/exit/${recorded.kinds.Exited}`)).json();
    expect((await verifyReceipt(r, chain)).ok).toBe(true);
  });
});
