/**
 * GET /v1/openapi.json: the public API described in OpenAPI 3.1, from the table below. A test fails if a route the
 * server answers is missing here, or a route here is not answered, so the description and the code cannot drift.
 */

export interface RouteDoc {
  path: string; // OpenAPI style: /v1/pots/{pot}
  summary: string;
  params?: { name: string; in: "path" | "query"; description: string; required?: boolean }[];
  /** The answer's data fields (JSON), or the media type for a non-JSON answer. */
  data: string[] | { media: string };
  tag: string;
}

const pot = { name: "pot", in: "path" as const, description: "a group account's address", required: true };
const addr = { name: "address", in: "path" as const, description: "an address", required: true };
const tx = { name: "tx", in: "path" as const, description: "a transaction hash", required: true };
const page = (what: string) => [
  { name: "after", in: "query" as const, description: `the next value of the previous page (${what})` },
  { name: "limit", in: "query" as const, description: "how many per page" },
];

export const ROUTES: RouteDoc[] = [
  { path: "/v1/status", tag: "status", summary: "Chain, latest block, indexer lag, relayer gas (yes or no) and the age of every price feed.", data: ["chainId", "headBlock", "indexer", "relayer", "feeds"] },
  { path: "/v1/badge.svg", tag: "status", summary: "A status image for a README or page: chain, and whether the indexer is live or behind.", data: { media: "image/svg+xml" } },
  { path: "/v1/tx/{hash}", tag: "proof", summary: "Any transaction in plain words: what each Cofer contract in it did, with every amount and address.", params: [{ name: "hash", in: "path", description: "a transaction hash", required: true }], data: ["hash", "cofer", "status", "block", "time", "from", "to", "kind", "summary", "events"] },
  { path: "/v1/proof/ownership", tag: "proof", summary: "Owner, guardian, pause flags, swap fee and fee wallets, each with the cast line to check it.", data: ["factory", "feeRouter", "exitsPausable", "checks"] },
  { path: "/v1/changelog.atom", tag: "feeds", summary: "The changelog as an Atom feed.", data: { media: "application/atom+xml" } },
  { path: "/v1/changelog.json", tag: "feeds", summary: "The changelog as a JSON Feed.", data: { media: "application/feed+json" } },
  { path: "/v1/pots/{pot}", tag: "groups", summary: "One group account: members count, vote rule, exit window, settings and every token it holds.", params: [pot], data: ["address", "createdBlock", "memberCount", "voteRule", "exitWindowSeconds", "depositsOpen", "maxSlipBps", "entrySpreadBps", "totalShares", "epoch", "planPaidUntil", "assets"] },
  { path: "/v1/pots/{pot}/members", tag: "groups", summary: "A group's members by address: active, shares, join block.", params: [pot, ...page("an address")], data: ["members", "next"] },
  { path: "/v1/pots/{pot}/votes", tag: "groups", summary: "A group's votes, with a summary made from the vote itself, approvals and transaction.", params: [pot, { name: "state", in: "query", description: "open, ready, queued, executed, expired, stale or failed" }, { name: "limit", in: "query", description: "how many" }], data: ["votes"] },
  { path: "/v1/pots/{pot}/timeline", tag: "groups", summary: "Everything a group did, in block order, in plain words.", params: [pot, ...page("block-logIndex")], data: ["events", "next"] },
  { path: "/v1/pots/{pot}/holdings", tag: "groups", summary: "A group's raw balance of each token, day by day. Balances only.", params: [pot, { name: "from", in: "query", description: "first day, YYYY-MM-DD" }, { name: "to", in: "query", description: "last day, YYYY-MM-DD" }], data: ["pot", "from", "to", "days"] },
  { path: "/v1/pots/{pot}/fees", tag: "groups", summary: "Every swap fee and plan payment a group paid, each with its transaction.", params: [pot, ...page("block-logIndex")], data: ["pot", "fees", "next"] },
  { path: "/v1/receipts/exit/{tx}", tag: "receipts", summary: "An exit's receipt: shares burned, every amount sent or set aside, and the calls to check each.", params: [tx], data: ["kind", "chainId", "tx", "block", "pot", "member", "to", "sharesBurned", "assets", "checks"] },
  { path: "/v1/receipts/deposit/{tx}", tag: "receipts", summary: "A deposit's receipt: amount, shares minted, the group's total before.", params: [tx], data: ["kind", "chainId", "tx", "block", "pot", "member", "amount", "sharesMinted", "groupTotalBefore", "usdg", "checks"] },
  { path: "/v1/receipts/spend/{tx}", tag: "receipts", summary: "An allowance spend's receipt: who spent, to whom, the memo and what is left.", params: [tx], data: ["kind", "chainId", "tx", "block", "pot", "spender", "to", "amount", "memo", "allowanceLeft", "usdg", "checks"] },
  { path: "/v1/receipts/vote/{digest}", tag: "receipts", summary: "A vote's receipt: the exact message signed, who approved, which approvals still verify.", params: [{ name: "digest", in: "path", description: "the vote id (its EIP-712 digest)", required: true }], data: ["kind", "chainId", "digest", "digestMatches", "pot", "action", "state", "txHash", "signed", "approvals", "checks"] },
  { path: "/v1/members/{address}", tag: "groups", summary: "Every group where an address is an active member, with shares and join block.", params: [addr], data: ["address", "groups"] },
  { path: "/v1/set-asides/{address}", tag: "groups", summary: "Tokens still set aside for an address, across all groups, with the claim to send.", params: [addr], data: ["address", "open"] },
  { path: "/v1/admin/pending", tag: "proof", summary: "Every change queued behind the 48-hour timelock, in plain words, and when it can apply.", data: ["pending", "recent"] },
  { path: "/v1/proof/snapshot/{pot}", tag: "proof", summary: "Every token a group held at a block, raw balance and reserved part, each with its command.", params: [pot, { name: "block", in: "query", description: "a block number (default: the newest the indexer counts)" }], data: ["pot", "block", "readable", "assets", "checks"] },
  { path: "/v1/openapi.json", tag: "about", summary: "This description.", data: { media: "application/json" } },
  { path: "/v1/llms.txt", tag: "about", summary: "The API in plain text for software agents: its rules and every call (also at /llms.txt).", data: { media: "text/plain" } },
];

export function openApiSpec(serverUrl: string, version: string) {
  const paths: Record<string, unknown> = {};
  for (const r of ROUTES) {
    const ok =
      "media" in r.data
        ? { description: "OK", content: { [r.data.media]: {} } }
        : {
            description: "OK",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["data", "meta"],
                  properties: {
                    data: { type: "object", required: r.data, properties: Object.fromEntries(r.data.map((k) => [k, {}])) },
                    meta: { $ref: "#/components/schemas/Meta" },
                  },
                },
              },
            },
          };
    paths[r.path] = {
      get: {
        summary: r.summary,
        tags: [r.tag],
        parameters: (r.params ?? []).map((p) => ({ name: p.name, in: p.in, required: p.in === "path" || !!p.required, description: p.description, schema: { type: "string" } })),
        responses: { "200": ok, "400": { $ref: "#/components/responses/Error" }, "404": { $ref: "#/components/responses/Error" }, "429": { $ref: "#/components/responses/Error" }, "503": { $ref: "#/components/responses/Error" } },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Cofer public API",
      version,
      description: "Read-only facts about Cofer from Robinhood Chain. GET only, no keys, 60 requests a minute per client. On-chain data only: never a Telegram name, id or chat id. Big numbers are decimal strings. Balances only: no prices, values or totals over time.",
    },
    servers: [{ url: serverUrl.replace(/\/$/, "") }],
    paths,
    components: {
      schemas: { Meta: { type: "object", required: ["chainId", "generatedAt", "cacheSeconds"], properties: { chainId: { type: "integer" }, generatedAt: { type: "string" }, cacheSeconds: { type: "integer" } } } },
      responses: { Error: { description: "An error", content: { "application/json": { schema: { type: "object", properties: { error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } } } } } } } },
    },
  };
}
