# arena-replay

Check any Arena game yourself, from public data only. MIT licensed (see LICENSE).

It reads the table from chain, downloads the game log and the price tape, and runs the same engine over them. A PASS is the same check each result signer makes before signing.

```
bun tools/arena-replay/arena-replay.ts verify <table> [--rpc <url>] [--log <file|https|ipfs uri>] [--tape <dir|uri>] [--engine-build 0x…] [--payouts rows.json]
bun tools/arena-replay/arena-replay.ts me <table> --seat <your address> [same options]
```

`verify` prints one line per step and exits 0 only if none failed:

1. **chain**: the rules in the log hash to the table's rulesHash, and the seats are the table's seats.
2. **tape**: every hour of prices the game used chains to the tapeHead anchored on chain.
3. **quotes**: every Chainlink price on the tape matches its round on chain (skip with `--no-quotes`).
4. **keys**: every session key hashes to the seat's on-chain sessionKeyHash, and every order's signature verifies.
5. **replay**: the engine run over the log's inputs gives exactly the posted events and logHead.
6. **result**: eventsRoot, standingsRoot and the podium (or the payout rows) are the replay's. With `--engine-build`, the signed digest is checked too.

`me` prints your equity once a minute (CSV), your fills, your rejected orders with the reason, and your largest drawdown.

The RPC defaults to `https://rpc.mainnet.chain.robinhood.com`. The log defaults to the logURI the result names. Nothing here needs a key.
