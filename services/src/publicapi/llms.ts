/**
 * GET /llms.txt and /v1/llms.txt: the public API in plain text for software agents: what it is, its rules, and every
 * call (from the same route table as /v1/openapi.json, so the two always list the same calls).
 */
import { ROUTES } from "./openapi";

export function llmsText(base: string): string {
  const b = base.replace(/\/$/, "");
  return [
    "# Cofer public API",
    "",
    "> Read-only facts about Cofer (shared group accounts on Robinhood Chain), straight from the chain.",
    "",
    "## Rules",
    "",
    "- Read-only: GET only. Nothing here can move money, sign or change anything.",
    "- On-chain data only: addresses, amounts, blocks and times. Never a Telegram name, username, id or chat id.",
    "- Balances only: raw token balances with their decimals. No prices, values or totals over time.",
    "- Big numbers (amounts, blocks) are decimal strings. Token amounts are raw units; `decimals` says how to read them.",
    "- 60 requests a minute per client address; over it, 429 with Retry-After.",
    "- Answers are `{ data, meta }`; errors are `{ error: { code, message } }`.",
    "- Exits can never be paused by anyone: no pause, vote or price feed reaches exit().",
    "",
    "## Calls",
    "",
    ...ROUTES.map((r) => `- [GET ${r.path}](${b}${r.path.replace(/\{(\w+)\}/g, "<$1>")}): ${r.summary}`),
    "",
    "## More",
    "",
    `- Full description: ${b}/v1/openapi.json`,
    `- A transaction in plain words, for people: ${b}/tx`,
    "",
  ].join("\n");
}
