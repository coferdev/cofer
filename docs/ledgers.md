# Ledgers

Tables the keeper builds from the indexer's stored chain events (`chain_events`), every minute. They are never built
inside the indexer's own loop, so a ledger can never slow or stop indexing. Each ledger keeps its position in the
`cursors` table (`ledger:<name>`) and writes its changes and its new position in one transaction: running it twice
counts nothing twice, and rebuilding it from the start gives the same table. Chain data only.

| Table | Built from | What it holds |
|---|---|---|
| `set_asides` | `ExitOwed`, `OwedClaimed` | per group account, token and recipient: amount set aside during exits, amount claimed; open = set aside - claimed (equals the group account's `owed(token, recipient)`). Recipients that are not members are included. |
