/**
 * Writes docs/api/reference.md from the public API's route table (src/publicapi/openapi.ts, the same table behind
 * /v1/openapi.json) and the field definitions below. A test fails if the file is out of date, if a route is missing,
 * or if any field an answer has is not defined here.
 *   bun scripts/gen-api-docs.ts            write the file
 *   bun scripts/gen-api-docs.ts --check    exit 1 if the file is not what this would write
 */
import { readFileSync, writeFileSync } from "node:fs";
import { ROUTES } from "../src/publicapi/openapi";

/** Every field that appears at the top level of an answer's data. */
export const FIELD_DOCS: Record<string, string> = {
  action: "what a vote does (send, swap, add a member, ...)",
  address: "the address asked about (checksummed)",
  allowanceLeft: "what is left of the spender's allowance this period, raw USDG",
  amount: "a raw token amount (use the token's decimals)",
  approvals: "the approvals of a vote: each approver's key, signature, whether withdrawn, and whether it still verifies",
  assets: "tokens held or paid, each with raw amounts and decimals",
  block: "a block number",
  bundles: "SHA-256 of the signing scripts this server serves (compare with a fresh build of the release)",
  chainId: "the chain: 4663 mainnet, 46630 testnet",
  checks: "read-only commands (cast) that check each figure against the chain, block numbers included",
  cofer: "whether any Cofer contract took part in the transaction",
  createdBlock: "the block the factory created the group account in",
  days: "one entry per day: the block it was read at and each token's raw balance",
  depositsOpen: "whether the group accepts deposits",
  digest: "a vote's id: the EIP-712 digest every approver signed",
  digestMatches: "whether the digest made again from the signed message equals the id",
  entrySpreadBps: "the group's entry spread in basis points",
  epoch: "goes up when membership changes; votes signed in an earlier epoch need signing again",
  events: "the transaction's or group's Cofer logs, each in plain words with its decoded fields",
  exitWindowSeconds: "how long a vote not every member approved waits before it can run, so members can exit first",
  exitsPausable: "always false: no pause, vote or price feed can stop an exit",
  factory: "the factory contract and its roles and settings",
  feeRouter: "the fee router contract, its roles and the fee wallets",
  feeds: "each price feed's state, age and limit",
  fees: "each fee a group paid, with its transaction",
  from: "the sender, or the first day of a range",
  groupTotalBefore: "the group's total in USDG as priced for a deposit, just before it (raw, 6 decimals)",
  groups: "the group accounts a key is an active member of",
  hash: "a transaction hash",
  headBlock: "the latest block the server sees",
  indexer: "the indexer's position and lag, and live / behind / not started",
  kind: "what kind of thing this is (a receipt kind, or the main action in a transaction)",
  maxSlipBps: "the group's swap price limit in basis points",
  member: "a member's key",
  memberCount: "active members",
  members: "members by address, with active flag, shares and join block",
  memo: "the memo recorded with an allowance spend (bytes32, as on chain)",
  next: "the value to pass as after for the next page (null on the last)",
  open: "tokens still set aside for an address, each with the claim to send",
  pending: "admin changes still queued behind the 48-hour timelock",
  planPaidUntil: "unix time the group's plan is paid until (null when never paid)",
  pot: "a group account's address",
  readable: "whether the server's RPC could read that block (old blocks need an archive RPC)",
  recent: "the last admin changes that were applied or replaced",
  relayer: "whether the relayer has gas to run passed votes, and about how many days it lasts (never its balance)",
  sharesBurned: "group shares an exit burned (18 decimals)",
  sharesMinted: "group shares a deposit minted (18 decimals)",
  signed: "the exact EIP-712 domain, types and message signed for a vote",
  spender: "the member who spent from their allowance",
  state: "where something stands (a vote's state, a change's state)",
  status: "whether a transaction succeeded or failed",
  summary: "one plain sentence saying what happened",
  time: "a unix time in seconds",
  to: "the recipient or destination, or the last day of a range",
  totalShares: "all group shares (18 decimals)",
  tx: "a transaction hash",
  txHash: "the transaction that ran a vote",
  usdg: "the USDG token's address",
  voteRule: "how many approvals a vote needs: the rule and the number now",
  votes: "a group's votes, each with a summary made from the vote itself",
};

export function referenceMarkdown(): string {
  const lines = [
    "# Cofer public API reference",
    "",
    "Generated from the API's route table (the same one behind `/v1/openapi.json`) by `services/scripts/gen-api-docs.ts`.",
    "Do not edit by hand. The guide with examples is [README.md](README.md).",
    "",
    "Rules for every route: read-only (GET); on-chain data only, never a Telegram name, username, id or chat id; balances",
    "only, as raw token amounts with their decimals, never prices, values or totals over time; big numbers are decimal",
    "strings; JSON answers are `{ data, meta }`, errors `{ error: { code, message } }`; 60 requests a minute per client.",
    "",
    "## Routes",
    "",
    "| Route | What it gives | Parameters | Answer |",
    "|---|---|---|---|",
    ...ROUTES.map((r) => `| \`GET ${r.path}\` | ${r.summary} | ${(r.params ?? []).map((p) => `\`${p.name}\` (${p.in}): ${p.description}`).join("<br>") || "none"} | ${Array.isArray(r.data) ? r.data.map((f) => `\`${f}\``).join(", ") : `\`${r.data.media}\``} |`),
    "",
    "## Fields",
    "",
    "| Field | Meaning |",
    "|---|---|",
    ...Object.entries(FIELD_DOCS)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([f, d]) => `| \`${f}\` | ${d} |`),
    "",
  ];
  return lines.join("\n");
}

export const REFERENCE_PATH = new URL("../../docs/api/reference.md", import.meta.url);

if (import.meta.main) {
  const want = referenceMarkdown();
  if (process.argv.includes("--check")) {
    const have = readFileSync(REFERENCE_PATH, "utf8");
    if (have !== want) {
      console.log("docs/api/reference.md is out of date: run bun scripts/gen-api-docs.ts");
      process.exit(1);
    }
    console.log("docs/api/reference.md is up to date");
  } else {
    writeFileSync(REFERENCE_PATH, want);
    console.log("wrote docs/api/reference.md");
  }
}
