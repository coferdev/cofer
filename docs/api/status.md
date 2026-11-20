# GET /v1/status

Is Cofer's backend keeping up with the chain? One call shows it.

```bash
curl https://<signer site>/v1/status
```

```json
{
  "data": {
    "chainId": 4663,
    "headBlock": "1000020",
    "indexer": { "state": "live", "lastBlock": "1000000", "targetBlock": "1000000", "lagBlocks": "0", "lagSeconds": 0, "maxLagSeconds": 300 },
    "relayer": { "hasGas": true, "daysLeft": 21.5 },
    "feeds": [
      { "symbol": "USDG", "asset": "0x5fc5…d168", "state": "ok", "ageSeconds": 600, "limitSeconds": 86400 }
    ]
  },
  "meta": { "chainId": 4663, "generatedAt": "2026-12-01T14:00:05.000Z", "cacheSeconds": 15 }
}
```

| Field | Meaning |
|---|---|
| `headBlock` | the latest block the server sees |
| `indexer.targetBlock` | the block the indexer should have reached: `headBlock` minus the confirmations it waits for |
| `indexer.lastBlock` | the last block the indexer saved (`null` before its first one) |
| `indexer.lagBlocks`, `lagSeconds` | how far `lastBlock` is behind `targetBlock`, in blocks and in chain time |
| `indexer.state` | `live` (within `maxLagSeconds`), `behind`, or `not started` |
| `relayer.hasGas` | whether the address that pays gas to run passed votes holds enough to do so (`null` if it could not be read just then). Exits never need it: any member can always exit on their own. |
| `relayer.daysLeft` | about how many days its gas lasts at its last 14 days' average spend (`null` with no recent spend). Days only, never the balance. |
| `feeds[].state` | `ok`, `near limit` (within an hour of its limit), `past limit` (deposits and swaps that need this price are refused until it updates; exits never read prices), or `bad` (a price the contract rejects) |
| `feeds[].limitSeconds` | the factory's `maxStaleness` for that asset |

Check it yourself: `cast block-number --rpc-url <RPC>` for the head, and for a feed
`cast call <factory> "assetInfo(address)" <asset>` then `cast call <feed> "latestRoundData()"`.
