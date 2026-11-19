# Receipts

A receipt is one Cofer action read from its own transaction: every figure, and the exact read-only commands that
check each one against the chain, block numbers included. Only logs from Cofer group accounts are read.

A transaction without that action answers `404` ("This transaction has no Cofer exit."); an unknown hash `404`; a
malformed hash `400`. A receipt never changes, so it may be cached for an hour.

## GET /v1/receipts/exit/:tx

`member`, `to` (the destination), `sharesBurned`, and per token in `assets`: `amount` (its share of the exit),
`sent` (transferred now) and `setAside` (kept for the destination to claim, when a transfer was refused). `sent` plus
`setAside` always equals `amount`.

Each `amount` is `distributable(token) x sharesBurned / totalShares`, both read just before the exit, rounded down.
The `checks` list gives those reads at the block before, the destination's balance before and after, and `owed` for
anything set aside.

## GET /v1/receipts/deposit/:tx

`member`, `amount` (USDG paid, raw, 6 decimals), `sharesMinted`, and `groupTotalBefore`: the group's total in USDG as
priced for this deposit, just before it (the base of the share maths).

Shares minted = paid x (total shares before + 10^12) / (`groupTotalBefore` + 1), rounded down. When the group held
anything other than USDG, "paid" is first reduced by the group's entry spread. The `checks` give total shares and the
settings at the block before, and the group's USDG before and after.

## GET /v1/receipts/vote/:digest

A vote by its id (the EIP-712 digest every approver signed): `signed` holds the exact domain, types and message,
`digestMatches` says the digest made again from them equals the id, and `approvals` lists each approver's key, its
signature, whether it was withdrawn, and `stillValid` (checked now; for keys that are smart accounts, through
ERC-1271). `action` and `state` say what the vote does and where it stands.

Recompute it yourself with the group account's own `hashProposal(kind, data, nonce, epoch, deadline)` (the first
line of `checks`), or `hashTypedData(signed)` with viem (numbers as bigints). Votes made outside the bot are listed
at [`/v1/pots/:pot/votes`](pots.md#get-v1potspotvotes) with their transaction. It may be cached for 15 seconds.
