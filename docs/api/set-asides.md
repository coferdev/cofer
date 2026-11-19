# GET /v1/set-asides/:address

Is anything set aside for an address? When a token cannot be sent during an exit (for example its issuer paused it),
the group account keeps it for the exit's destination. This lists every token still set aside for an address, across
all group accounts, from the [set-aside ledger](../ledgers.md).

```bash
curl https://<signer site>/v1/set-asides/0x…
```

Each item: `pot`, `asset` (with `symbol` and `decimals`), `open` (raw amount still set aside), `lastBlock`, and
`claim`: the call to send (`claimOwed(token, address)` to the group account). Anyone may send it, from any wallet; the
tokens always go to the address they were set aside for. `check` is the command that reads the same amount from the
group account (`owed(token, address)`). Nothing open: an empty list. It may be cached for 15 seconds.
