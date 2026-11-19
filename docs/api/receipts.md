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
