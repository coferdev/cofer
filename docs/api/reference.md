# Cofer public API reference

Generated from the API's route table (the same one behind `/v1/openapi.json`) by `services/scripts/gen-api-docs.ts`.
Do not edit by hand. The guide with examples is [README.md](README.md).

Rules for every route: read-only (GET); on-chain data only, never a Telegram name, username, id or chat id; balances
only, as raw token amounts with their decimals, never prices, values or totals over time; big numbers are decimal
strings; JSON answers are `{ data, meta }`, errors `{ error: { code, message } }`; 60 requests a minute per client.

## Routes

| Route | What it gives | Parameters | Answer |
|---|---|---|---|
| `GET /v1/status` | Chain, latest block, indexer lag, relayer gas (yes or no) and the age of every price feed. | none | `chainId`, `headBlock`, `indexer`, `relayer`, `feeds`, `bundles` |
| `GET /v1/badge.svg` | A status image for a README or page: chain, and whether the indexer is live or behind. | none | `image/svg+xml` |
| `GET /v1/tx/{hash}` | Any transaction in plain words: what each Cofer contract in it did, with every amount and address. | `hash` (path): a transaction hash | `hash`, `cofer`, `status`, `block`, `time`, `from`, `to`, `kind`, `summary`, `events` |
| `GET /v1/proof/ownership` | Owner, guardian, pause flags, swap fee and fee wallets, each with the cast line to check it. | none | `factory`, `feeRouter`, `exitsPausable`, `checks` |
| `GET /v1/changelog.atom` | The changelog as an Atom feed. | none | `application/atom+xml` |
| `GET /v1/changelog.json` | The changelog as a JSON Feed. | none | `application/feed+json` |
| `GET /v1/pots/{pot}` | One group account: members count, vote rule, exit window, settings and every token it holds. | `pot` (path): a group account's address | `address`, `createdBlock`, `memberCount`, `voteRule`, `exitWindowSeconds`, `depositsOpen`, `maxSlipBps`, `entrySpreadBps`, `totalShares`, `epoch`, `planPaidUntil`, `assets` |
| `GET /v1/pots/{pot}/members` | A group's members by address: active, shares, join block. | `pot` (path): a group account's address<br>`after` (query): the next value of the previous page (an address)<br>`limit` (query): how many per page | `members`, `next` |
| `GET /v1/pots/{pot}/votes` | A group's votes, with a summary made from the vote itself, approvals and transaction. | `pot` (path): a group account's address<br>`state` (query): open, ready, queued, executed, expired, stale or failed<br>`limit` (query): how many | `votes` |
| `GET /v1/pots/{pot}/timeline` | Everything a group did, in block order, in plain words. | `pot` (path): a group account's address<br>`after` (query): the next value of the previous page (block-logIndex)<br>`limit` (query): how many per page | `events`, `next` |
| `GET /v1/pots/{pot}/holdings` | A group's raw balance of each token, day by day. Balances only. | `pot` (path): a group account's address<br>`from` (query): first day, YYYY-MM-DD<br>`to` (query): last day, YYYY-MM-DD | `pot`, `from`, `to`, `days` |
| `GET /v1/pots/{pot}/fees` | Every swap fee and plan payment a group paid, each with its transaction. | `pot` (path): a group account's address<br>`after` (query): the next value of the previous page (block-logIndex)<br>`limit` (query): how many per page | `pot`, `fees`, `next` |
| `GET /v1/pots/{pot}/feed.atom` | One group's own feed: each deposit, exit, vote and allowance spend, newest first (Atom). | `pot` (path): a group account's address | `application/atom+xml` |
| `GET /v1/pots/{pot}/feed.json` | The same group feed as JSON Feed. | `pot` (path): a group account's address | `application/feed+json` |
| `GET /v1/receipts/exit/{tx}` | An exit's receipt: shares burned, every amount sent or set aside, and the calls to check each. | `tx` (path): a transaction hash | `kind`, `chainId`, `tx`, `block`, `pot`, `member`, `to`, `sharesBurned`, `assets`, `checks` |
| `GET /v1/receipts/deposit/{tx}` | A deposit's receipt: amount, shares minted, the group's total before. | `tx` (path): a transaction hash | `kind`, `chainId`, `tx`, `block`, `pot`, `member`, `amount`, `sharesMinted`, `groupTotalBefore`, `usdg`, `checks` |
| `GET /v1/receipts/spend/{tx}` | An allowance spend's receipt: who spent, to whom, the memo and what is left. | `tx` (path): a transaction hash | `kind`, `chainId`, `tx`, `block`, `pot`, `spender`, `to`, `amount`, `memo`, `allowanceLeft`, `usdg`, `checks` |
| `GET /v1/receipts/vote/{digest}` | A vote's receipt: the exact message signed, who approved, which approvals still verify. | `digest` (path): the vote id (its EIP-712 digest) | `kind`, `chainId`, `digest`, `digestMatches`, `pot`, `action`, `state`, `txHash`, `signed`, `approvals`, `checks` |
| `GET /v1/members/{address}` | Every group where an address is an active member, with shares and join block. | `address` (path): an address | `address`, `groups` |
| `GET /v1/set-asides/{address}` | Tokens still set aside for an address, across all groups, with the claim to send. | `address` (path): an address | `address`, `open` |
| `GET /v1/admin/pending` | Every change queued behind the 48-hour timelock, in plain words, and when it can apply. | none | `pending`, `recent` |
| `GET /v1/proof/snapshot/{pot}` | Every token a group held at a block, raw balance and reserved part, each with its command. | `pot` (path): a group account's address<br>`block` (query): a block number (default: the newest the indexer counts) | `pot`, `block`, `readable`, `assets`, `checks` |
| `GET /v1/openapi.json` | This description. | none | `application/json` |
| `GET /v1/llms.txt` | The API in plain text for software agents: its rules and every call (also at /llms.txt). | none | `text/plain` |

## Fields

| Field | Meaning |
|---|---|
| `action` | what a vote does (send, swap, add a member, ...) |
| `address` | the address asked about (checksummed) |
| `allowanceLeft` | what is left of the spender's allowance this period, raw USDG |
| `amount` | a raw token amount (use the token's decimals) |
| `approvals` | the approvals of a vote: each approver's key, signature, whether withdrawn, and whether it still verifies |
| `assets` | tokens held or paid, each with raw amounts and decimals |
| `block` | a block number |
| `bundles` | SHA-256 of the signing scripts this server serves (compare with a fresh build of the release) |
| `chainId` | the chain: 4663 mainnet, 46630 testnet |
| `checks` | read-only commands (cast) that check each figure against the chain, block numbers included |
| `cofer` | whether any Cofer contract took part in the transaction |
| `createdBlock` | the block the factory created the group account in |
| `days` | one entry per day: the block it was read at and each token's raw balance |
| `depositsOpen` | whether the group accepts deposits |
| `digest` | a vote's id: the EIP-712 digest every approver signed |
| `digestMatches` | whether the digest made again from the signed message equals the id |
| `entrySpreadBps` | the group's entry spread in basis points |
| `epoch` | goes up when membership changes; votes signed in an earlier epoch need signing again |
| `events` | the transaction's or group's Cofer logs, each in plain words with its decoded fields |
| `exitsPausable` | always false: no pause, vote or price feed can stop an exit |
| `exitWindowSeconds` | how long a vote not every member approved waits before it can run, so members can exit first |
| `factory` | the factory contract and its roles and settings |
| `feeds` | each price feed's state, age and limit |
| `feeRouter` | the fee router contract, its roles and the fee wallets |
| `fees` | each fee a group paid, with its transaction |
| `from` | the sender, or the first day of a range |
| `groups` | the group accounts a key is an active member of |
| `groupTotalBefore` | the group's total in USDG as priced for a deposit, just before it (raw, 6 decimals) |
| `hash` | a transaction hash |
| `headBlock` | the latest block the server sees |
| `indexer` | the indexer's position and lag, and live / behind / not started |
| `kind` | what kind of thing this is (a receipt kind, or the main action in a transaction) |
| `maxSlipBps` | the group's swap price limit in basis points |
| `member` | a member's key |
| `memberCount` | active members |
| `members` | members by address, with active flag, shares and join block |
| `memo` | the memo recorded with an allowance spend (bytes32, as on chain) |
| `next` | the value to pass as after for the next page (null on the last) |
| `open` | tokens still set aside for an address, each with the claim to send |
| `pending` | admin changes still queued behind the 48-hour timelock |
| `planPaidUntil` | unix time the group's plan is paid until (null when never paid) |
| `pot` | a group account's address |
| `readable` | whether the server's RPC could read that block (old blocks need an archive RPC) |
| `recent` | the last admin changes that were applied or replaced |
| `relayer` | whether the relayer has gas to run passed votes, and about how many days it lasts (never its balance) |
| `sharesBurned` | group shares an exit burned (18 decimals) |
| `sharesMinted` | group shares a deposit minted (18 decimals) |
| `signed` | the exact EIP-712 domain, types and message signed for a vote |
| `spender` | the member who spent from their allowance |
| `state` | where something stands (a vote's state, a change's state) |
| `status` | whether a transaction succeeded or failed |
| `summary` | one plain sentence saying what happened |
| `time` | a unix time in seconds |
| `to` | the recipient or destination, or the last day of a range |
| `totalShares` | all group shares (18 decimals) |
| `tx` | a transaction hash |
| `txHash` | the transaction that ran a vote |
| `usdg` | the USDG token's address |
| `voteRule` | how many approvals a vote needs: the rule and the number now |
| `votes` | a group's votes, each with a summary made from the vote itself |
