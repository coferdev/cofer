# Cofer public API

Read-only facts about Cofer, straight from Robinhood Chain. No sign-in and no keys.

- **Address:** the signer site's address plus `/v1`, for example `https://<signer site>/v1/status`.
- **Read-only:** only `GET` (and `OPTIONS` for browsers). Nothing here can move money or change anything.
- **On-chain data only:** addresses, amounts, blocks and times that anyone can read from the chain. Never a
  Telegram name, username, id or chat id.
- **Limits:** 60 requests a minute per client address, and a cap for all clients together. Over it, the answer is
  `429` with a `Retry-After` header (seconds).
- **CORS:** open for `GET`, so any page or tool can call it.
- **Caching:** each route says how long its answer may be cached (`Cache-Control`, and `meta.cacheSeconds`).
  Answers are read once per cache period for everyone, so a busy API never slows the bot.

## Answer format

```json
{
  "data": { "...": "..." },
  "meta": { "chainId": 4663, "generatedAt": "2026-12-01T14:00:05.000Z", "cacheSeconds": 15 }
}
```

- Token amounts and block numbers are decimal strings (`"1000020"`), so nothing is rounded.
- Token amounts are raw units; each answer gives the token's `decimals` where it shows an amount.
- Errors: `{ "error": { "code": "not_found", "message": "..." } }` with the matching HTTP status
  (`400`, `404`, `405`, `429`, or `503` when the chain or database cannot be read just then).

## Routes

| Route | What it gives |
|---|---|
| [`GET /v1/status`](status.md) | chain, latest block, indexer lag, relayer gas (yes or no), age of every price feed |
| [`GET /v1/badge.svg`](badge.md) | a status image for a README or page: chain, and whether the indexer is live or behind |
| [`GET /v1/tx/:hash`](tx.md) | any transaction in plain words: what each Cofer contract in it did, with every amount and address. Also a page: `/tx` |
| [`GET /v1/proof/ownership`](ownership.md) | owner, guardian, pause flags, swap fee and fee wallets, each with the `cast` line to check it |
| [`GET /v1/changelog.atom`, `/v1/changelog.json`](changelog.md) | the changelog as a feed (Atom and JSON Feed): every release, newest first |
| [`GET /v1/pots/:pot`](pots.md) | one group account: members count, vote rule, exit window, settings and every token it holds |
| [`GET /v1/pots/:pot/members`](pots.md#get-v1potspotmembers) | a group's members by address: active, shares, join block; paged |
| [`GET /v1/pots/:pot/votes`](pots.md#get-v1potspotvotes) | a group's votes by state, with a summary made from the vote itself, approvals and transaction; votes made outside the bot included |
| [`GET /v1/pots/:pot/timeline`](pots.md#get-v1potspottimeline) | everything a group did, in block order, in plain words, each with its transaction; paged |
| [`GET /v1/receipts/exit/:tx`](receipts.md#get-v1receiptsexittx) | an exit's receipt: shares burned, every amount sent or set aside, and the calls to check each |
| [`GET /v1/receipts/deposit/:tx`](receipts.md#get-v1receiptsdeposittx) | a deposit's receipt: amount, shares minted, the group's total before, and the calls to check each |
\n| [`GET /v1/receipts/vote/:digest`](receipts.md#get-v1receiptsvotedigest) | a vote's receipt: the exact message signed, who approved, which approvals still verify, how to recompute it |\n| [`GET /v1/receipts/spend/:tx`](receipts.md#get-v1receiptsspendtx) | an allowance spend's receipt: who spent, to whom, the memo and what is left |\n| [`GET /v1/members/:address`](pots.md#get-v1membersaddress) | every group where a key is an active member, with shares and join block |\n| [`GET /v1/set-asides/:address`](set-asides.md) | tokens still set aside for an address, across all groups, with the claim to send |\n| [`GET /v1/admin/pending`](admin.md) | every change queued behind the 48-hour timelock, in plain words, and when it can apply |\n