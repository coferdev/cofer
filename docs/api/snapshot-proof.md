# GET /v1/proof/snapshot/:pot?block=N

Every token a group account held at a block, with its raw balance and the part reserved for set-aside claims (the
rest is what exits share), each with the exact read-only command, block number included, to check it yourself.

```bash
curl "https://<signer site>/v1/proof/snapshot/0x362B…2E50?block=153000000"
```

Without `block`: the newest block the indexer would count (head minus its confirmations). Balances only: no price,
value or total.

Old blocks need an archive RPC. If the server's RPC cannot answer for the block you ask, the answer has
`"readable": false` and still gives the commands, to run on an archive RPC. A past block's answer may be cached for
an hour; the default block's for 15 seconds.
