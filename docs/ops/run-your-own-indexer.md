# Run your own indexer

Check Cofer's public data without trusting Cofer's servers: run Cofer's own indexer against Robinhood Chain's public
RPC with your own Postgres, then compare what you index with Cofer's public API.

The indexer runs in **observe-only** mode: it records every log of the factory, the fee router and every group
account the factory created (found from the factory's own `PotCreated` logs), and nothing else. It sends nothing,
signs nothing, and needs no Telegram account.

## 1. Get the code and a database

Paste one line at a time:

```bash
git clone https://github.com/coferdev/cofer.git && cd cofer/services
bun install --frozen-lockfile
createdb cofer_mine
DATABASE_URL=postgres://localhost:5432/cofer_mine bunx drizzle-kit migrate
```

## 2. Settings

Make a file `mine.env` (testnet shown; mainnet values are in `contracts/deployments/4663.json`):

```bash
CHAIN_ID=46630
RHC_RPC_URL=https://rpc.testnet.chain.robinhood.com
DATABASE_URL=postgres://localhost:5432/cofer_mine
FACTORY_ADDRESS=0x814c1422e3efb7762b08533e518b758033f25e45
ADAPTER_ADDRESS=0x522979fee39c148ff181404babb0dc78d427f3ec
USDG_ADDRESS=0x14119629e364a53ceda500d0c1111dbb136a7398
START_BLOCK=147056436
INDEXER_OBSERVE_ONLY=1
ROLE=indexer
```

`START_BLOCK` is the block the factory was deployed in. That is all: observe-only needs no Redis, no Telegram bot, no signer
site and no key, and refuses to run as anything but the indexer.

## 3. Run it

```bash
set -a; . ./mine.env; set +a
bun src/index.ts
```

At start it checks that the RPC is on `CHAIN_ID` (`[start] chain guard: ...`), then reads the chain in steps of
2,000 blocks. Watch its progress:

```bash
psql cofer_mine -c "select block from cursors where name = 'main'"
psql cofer_mine -c "select name, count(*) from chain_events group by name order by name"
```

## 4. Compare with Cofer's public API

For any group account, once your index has caught up:

```bash
bun scripts/ops/compare.ts --pot 0x… --api https://<signer site>
```

It rebuilds each member's shares from your own stored events and compares them with `/v1/pots/:pot/members`, and
checks that every event in `/v1/pots/:pot/timeline` is in your index. No difference: `Your index and Cofer's API
agree`. Any difference is listed, and you can check it against the chain itself, for example:

```bash
cast call <group account> "memberInfo(address)((bool,uint256,uint128,uint32,uint64,uint128))" <member> --rpc-url https://rpc.testnet.chain.robinhood.com
```

The public RPC limits how many blocks one request may cover; the indexer stays well within it.
