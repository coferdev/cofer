#!/usr/bin/env bun
/**
 * Cofer's read-only MCP (Model Context Protocol) server, for software agents. Every tool reads the public API; no
 * tool can sign, send or change anything, and the server holds no key. No dependencies: the protocol's JSON-RPC
 * messages are handled here directly.
 *   bun tools/mcp/server.ts --api https://<signer site>              stdio (one JSON-RPC message per line)
 *   bun tools/mcp/server.ts --api https://<signer site> --http 8787   HTTP: POST /mcp
 */

export const PROTOCOL_VERSION = "2025-06-18";
export const SERVER_INFO = { name: "cofer-readonly", version: "1.0.0" };

type Json = Record<string, unknown>;
const addr = { type: "string", pattern: "^0x[0-9a-fA-F]{40}$", description: "a group account's address" };

export const TOOLS = [
  { name: "get_status", description: "Cofer's backend status: chain, latest block, indexer lag, relayer gas (yes or no), price feed ages.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, path: () => "/v1/status" },
  { name: "get_pot", description: "One group account: members count, vote rule, exit window, settings and every token it holds (raw balances).", inputSchema: { type: "object", properties: { pot: addr }, required: ["pot"], additionalProperties: false }, path: (a: Json) => `/v1/pots/${a.pot}` },
  { name: "get_members", description: "A group account's members by address, with active flag, shares and join block. Paged.", inputSchema: { type: "object", properties: { pot: addr, after: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 200 } }, required: ["pot"], additionalProperties: false }, path: (a: Json) => `/v1/pots/${a.pot}/members${qs({ after: a.after, limit: a.limit })}` },
  { name: "get_votes", description: "A group account's votes: summary made from the vote itself, state, approvals and transaction.", inputSchema: { type: "object", properties: { pot: addr, state: { type: "string", enum: ["open", "ready", "queued", "executed", "expired", "stale", "failed"] } }, required: ["pot"], additionalProperties: false }, path: (a: Json) => `/v1/pots/${a.pot}/votes${qs({ state: a.state })}` },
  { name: "get_timeline", description: "Everything a group account did, in block order, in plain words, each with its transaction. Paged.", inputSchema: { type: "object", properties: { pot: addr, after: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 200 } }, required: ["pot"], additionalProperties: false }, path: (a: Json) => `/v1/pots/${a.pot}/timeline${qs({ after: a.after, limit: a.limit })}` },
  { name: "explain_tx", description: "Any Robinhood Chain transaction in plain words: what each Cofer contract in it did, with every amount and address.", inputSchema: { type: "object", properties: { hash: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" } }, required: ["hash"], additionalProperties: false }, path: (a: Json) => `/v1/tx/${a.hash}` },
] as const;

function qs(q: Record<string, unknown>): string {
  const e = Object.entries(q).filter(([, v]) => v !== undefined && v !== null && v !== "");
  return e.length ? `?${e.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&")}` : "";
}

/** Checks a tool's arguments against its input schema (the few rules used above). */
export function argProblem(tool: (typeof TOOLS)[number], a: Json): string | null {
  const s = tool.inputSchema as { properties: Record<string, { type: string; pattern?: string; enum?: readonly string[]; minimum?: number; maximum?: number }>; required?: readonly string[] };
  for (const k of s.required ?? []) if (a[k] === undefined) return `missing argument "${k}"`;
  for (const [k, v] of Object.entries(a)) {
    const p = s.properties[k];
    if (!p) return `unknown argument "${k}"`;
    if (p.type === "string" && typeof v !== "string") return `"${k}" must be text`;
    if (p.type === "integer" && (!Number.isInteger(v) || (p.minimum !== undefined && (v as number) < p.minimum) || (p.maximum !== undefined && (v as number) > p.maximum))) return `"${k}" must be a whole number in range`;
    if (p.pattern && !new RegExp(p.pattern).test(String(v))) return `"${k}" is not in the right form`;
    if (p.enum && !p.enum.includes(String(v))) return `"${k}" must be one of ${p.enum.join(", ")}`;
  }
  return null;
}

export function createServer(o: { api: string; fetch?: typeof fetch }) {
  const f = o.fetch ?? fetch;
  const base = o.api.replace(/\/$/, "");
  /** Handles one JSON-RPC message; null for a notification (no answer). */
  return async function handle(msg: Json): Promise<Json | null> {
    const id = msg.id as string | number | undefined;
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    const error = (code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
    if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return error(-32600, "Invalid request");
    if (id === undefined) return null; // notifications (initialized, cancelled) need no answer
    switch (msg.method) {
      case "initialize":
        return reply({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: "Read-only Cofer data from Robinhood Chain. No tool can sign or send." });
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true } })) });
      case "tools/call": {
        const p = (msg.params ?? {}) as { name?: string; arguments?: Json };
        const tool = TOOLS.find((t) => t.name === p.name);
        if (!tool) return error(-32602, `Unknown tool: ${String(p.name)}`);
        const args = p.arguments ?? {};
        const bad = argProblem(tool, args);
        if (bad) return reply({ content: [{ type: "text", text: `Not run: ${bad}.` }], isError: true });
        try {
          const r = await f(`${base}${tool.path(args)}`, { headers: { accept: "application/json" } });
          const text = await r.text();
          return reply({ content: [{ type: "text", text }], isError: !r.ok });
        } catch {
          return reply({ content: [{ type: "text", text: "The Cofer API could not be reached just now." }], isError: true });
        }
      }
      default:
        return error(-32601, `Method not found: ${msg.method}`);
    }
  };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (k: string) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const api = flag("api") ?? process.env.COFER_API;
  if (!api) {
    console.error("usage: bun tools/mcp/server.ts --api https://<signer site> [--http <port>]");
    process.exit(2);
  }
  const handle = createServer({ api });
  const port = flag("http");
  if (port) {
    Bun.serve({
      port: Number(port),
      hostname: "127.0.0.1",
      async fetch(req) {
        if (new URL(req.url).pathname !== "/mcp" || req.method !== "POST") return new Response("POST JSON-RPC to /mcp", { status: 404 });
        const out = await handle((await req.json().catch(() => ({}))) as Json);
        return out ? Response.json(out) : new Response(null, { status: 202 });
      },
    });
    console.error(`cofer MCP server on http://127.0.0.1:${port}/mcp (read-only)`);
  } else {
    let buf = "";
    for await (const chunk of Bun.stdin.stream()) {
      buf += new TextDecoder().decode(chunk);
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: Json;
        try {
          msg = JSON.parse(line);
        } catch {
          process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`);
          continue;
        }
        const out = await handle(msg);
        if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
      }
    }
  }
}
