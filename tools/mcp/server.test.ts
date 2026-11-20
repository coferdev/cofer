/** An MCP client harness against the server, with a fake public API. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createServer, PROTOCOL_VERSION, TOOLS } from "./server";

const POT = "0x362B6794E6374b400aA186C1a67AC2c060af2E50";
const HASH = `0x${"ab".repeat(32)}`;
const asked: string[] = [];
const fakeApi = (async (url: string | URL | Request) => {
  asked.push(String(url));
  const path = new URL(String(url)).pathname;
  if (path.includes("0x0000000000000000000000000000000000000abc")) return new Response('{"error":{"code":"not_found","message":"No Cofer group account at this address."}}', { status: 404 });
  return new Response(JSON.stringify({ data: { path }, meta: {} }), { status: 200 });
}) as unknown as typeof fetch;
const server = createServer({ api: "https://sign.example/", fetch: fakeApi });
let n = 0;
const call = (method: string, params?: unknown) => server({ jsonrpc: "2.0", id: ++n, method, params });

describe("read-only MCP server", () => {
  test("initialize, then the six tools, all marked read-only", async () => {
    const init = (await call("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1" } }))!;
    expect((init.result as { protocolVersion: string; serverInfo: { name: string } }).serverInfo.name).toBe("cofer-readonly");
    expect(await server({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    const list = (await call("tools/list"))!.result as { tools: { name: string; annotations: { readOnlyHint: boolean } }[] };
    expect(list.tools.map((t) => t.name)).toEqual(["get_status", "get_pot", "get_members", "get_votes", "get_timeline", "explain_tx"]);
    expect(list.tools.every((t) => t.annotations.readOnlyHint)).toBe(true);
  });

  test("each tool reads its public API route", async () => {
    const want: [string, Record<string, unknown>, string][] = [
      ["get_status", {}, "/v1/status"],
      ["get_pot", { pot: POT }, `/v1/pots/${POT}`],
      ["get_members", { pot: POT, limit: 2 }, `/v1/pots/${POT}/members?limit=2`],
      ["get_votes", { pot: POT, state: "queued" }, `/v1/pots/${POT}/votes?state=queued`],
      ["get_timeline", { pot: POT, after: "100-1" }, `/v1/pots/${POT}/timeline?after=100-1`],
      ["explain_tx", { hash: HASH }, `/v1/tx/${HASH}`],
    ];
    for (const [name, args, path] of want) {
      asked.length = 0;
      const r = (await call("tools/call", { name, arguments: args }))!.result as { content: { text: string }[]; isError: boolean };
      expect(asked).toEqual([`https://sign.example${path}`]);
      expect(r.isError).toBe(false);
    }
  });

  test("bad arguments are refused before any call; API errors come back as tool errors", async () => {
    asked.length = 0;
    const bad = (await call("tools/call", { name: "get_pot", arguments: { pot: "nope" } }))!.result as { content: { text: string }[]; isError: boolean };
    expect(bad).toEqual({ content: [{ type: "text", text: 'Not run: "pot" is not in the right form.' }], isError: true });
    expect((await call("tools/call", { name: "get_votes", arguments: { pot: POT, state: "won" } }))!.result).toMatchObject({ isError: true });
    expect(asked).toEqual([]);
    const missing = (await call("tools/call", { name: "get_pot", arguments: { pot: "0x0000000000000000000000000000000000000abc" } }))!.result as { content: { text: string }[]; isError: boolean };
    expect(missing.isError).toBe(true);
    expect(missing.content[0]!.text).toContain("No Cofer group account");
    expect((await call("tools/call", { name: "send_tx", arguments: {} }))!.error).toEqual({ code: -32602, message: "Unknown tool: send_tx" });
  });

  test("no tool can sign or send: every tool is a GET of the public API, and the server holds no key", () => {
    expect(TOOLS.every((t) => t.name.startsWith("get_") || t.name === "explain_tx")).toBe(true);
    const src = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/method:\s*"(POST|PUT|DELETE)"|sendTransaction|writeContract|signTypedData|privateKey/);
  });

  test("unknown methods and malformed messages", async () => {
    expect((await call("resources/list"))!.error).toMatchObject({ code: -32601 });
    expect((await server({ id: 1 }))!.error).toMatchObject({ code: -32600 });
  });
});
