# GET /v1/tx/:hash

Any transaction, explained in plain words: a deposit, an exit, an allowance spend, a claim, a swap, a vote queued or
run, a group created, a plan payment, or an admin change, with every amount and address.

```bash
curl https://<signer site>/v1/tx/0x…
```

There is also a page for people: `https://<signer site>/tx`. Paste a hash and read the answer. It runs no script.

## What is read

- Only logs from Cofer contracts: the factory, the fee router, and group accounts the factory confirms
  (`isPot`). Token transfers and logs from any other contract are left out, never guessed at.
- A transaction with no Cofer log answers `"cofer": false`: "Not a Cofer transaction".
- A Cofer transaction that failed on-chain says so: nothing in it took effect.
- Amounts use the token's decimals (USDG has 6). A token that cannot be read is shown in raw units with its address.
- Group shares have 18 decimals (the first 1 USDG deposited mints 1 share).

## Answer

```json
{
  "data": {
    "hash": "0x…",
    "cofer": true,
    "status": "succeeded",
    "block": "153000000",
    "time": 1762560000,
    "from": "0x…",
    "to": "0x…",
    "kind": "deposit",
    "summary": "A Cofer deposit: 0xD6D8… deposited 100 USDG into group account 0x50F1… and received 100 shares.",
    "events": [
      { "contract": "group account", "address": "0x50F1…", "event": "Deposited", "logIndex": 3, "text": "…", "args": { "member": "0xD6D8…", "amount": "100000000", "shares": "100000000000000000000", "navBefore": "0" } }
    ]
  },
  "meta": { "chainId": 4663, "generatedAt": "…", "cacheSeconds": 3600 }
}
```

`kind` is the main thing that happened (`null` when nothing took effect). `events` lists every Cofer log in order,
each with its decoded fields as decimal strings.

Errors: `400` for a malformed hash, `404` when the chain has no transaction with that hash (yet).

Check it yourself: open the same hash on the block explorer and compare the logs, or
`cast receipt <hash> --rpc-url <RPC>`.
