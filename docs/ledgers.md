# Ledgers

Tables the keeper builds from the indexer's stored chain events (`chain_events`), every minute. They are never built
inside the indexer's own loop, so a ledger can never slow or stop indexing. Each ledger keeps its position in the
`cursors` table (`ledger:<name>`) and writes its changes and its new position in one transaction: running it twice
counts nothing twice, and rebuilding it from the start gives the same table. Chain data only.

| Table | Built from | What it holds |
|---|---|---|
| `set_asides` | `ExitOwed`, `OwedClaimed` | per group account, token and recipient: amount set aside during exits, amount claimed; open = set aside - claimed (equals the group account's `owed(token, recipient)`). Recipients that are not members are included. |
| `pending_admin_changes` | the factory's `FeedQueued`/`FeedApplied`, `AdapterQueued`/`AdapterSet`, `SwapFeeQueued`/`SwapFeeSet` | every change queued behind the 48-hour timelock: what (`kind`, `subject`, `new_value`), the earliest time it can apply (`eta`), and its `state`: `queued`, `applied`, or `replaced` by a newer queued change for the same thing |
| `holdings_daily` | the chain, once a day (keeper `snapshots` job) | each group account's raw balance of every token it holds at the block nearest 00:00 UTC. Balances only: no price, value or total. `block` and `block_time` say exactly where each was read (the newest block when the RPC could not answer for midnight's). |
| `fees` | group accounts' `Swapped` (its `fee`) and `PlanPaid` | every fee a group paid, one row per log: the swap fee (in the token swapped in) and plan payments (in USDG), with the transaction. The fee router's own `PlanPaid` copy is not counted twice. |
| `relayer_spend` | the transactions behind `ProposalExecuted` logs, kept when the relayer sent them | the gas cost (gas used x effective gas price, in wei) of every passed vote the relayer ran, with its UTC day. A vote a member ran themselves is not counted. |
