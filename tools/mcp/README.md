# Cofer read-only MCP server

An MCP (Model Context Protocol) server that lets software agents look up Cofer groups, members, votes, timelines and
transactions through the [public API](../../docs/api/README.md). Every tool is read-only: the server holds no key
and no tool can sign, send or change anything. No dependencies.

```bash
bun tools/mcp/server.ts --api https://<signer site>              # stdio
bun tools/mcp/server.ts --api https://<signer site> --http 8787   # HTTP, POST JSON-RPC to http://127.0.0.1:8787/mcp
```

Add it to any MCP client as a command: `bun /path/to/cofer/tools/mcp/server.ts --api https://<signer site>`.

| Tool | Arguments | Reads |
|---|---|---|
| `get_status` | none | `/v1/status` |
| `get_pot` | `pot` | `/v1/pots/:pot` |
| `get_members` | `pot`, `after?`, `limit?` | `/v1/pots/:pot/members` |
| `get_votes` | `pot`, `state?` | `/v1/pots/:pot/votes` |
| `get_timeline` | `pot`, `after?`, `limit?` | `/v1/pots/:pot/timeline` |
| `explain_tx` | `hash` | `/v1/tx/:hash` |

Arguments are checked before any call. Each answer is the API's JSON as text. `bun test` in this folder runs a
client harness against every tool with a fake API.
