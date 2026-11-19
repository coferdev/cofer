# GET /v1/proof/ownership

Who controls Cofer's contracts, and what is switched on, read live from the chain. Every value comes with the exact
`cast call` line that reads it again, so you can check it without trusting this server.

```bash
curl https://<signer site>/v1/proof/ownership
```

| Field | Meaning |
|---|---|
| `factory.owner` | the factory's owner (the team's multisig on mainnet) |
| `factory.pendingOwner` | a hand-over in progress (`null` when none): ownership moves only when this address accepts |
| `factory.guardian` | the address that can pause deposits and group creation |
| `factory.depositsPaused`, `creationPaused` | the two pause flags |
| `factory.swapFeeBps` | the swap fee in basis points (30 = 0.30%) |
| `factory.queuedSwapFeeBps`, `queuedSwapFeeEta` | a new fee waiting for its timelock, and the unix time it can apply after (`null` when none) |
| `feeRouter.owner`, `pendingOwner` | the same for the fee router |
| `feeRouter.sinks` | the four fee wallets and their shares in basis points |
| `exitsPausable` | always `false`: no pause flag, vote or price feed can stop `exit()` |
| `checks` | one line per value: what it is, the value, and the command that reads it |

## Check it yourself

Copy any line from `checks`, for example:

```bash
cast call 0x5d03d53A5630ceCC545Be46635779094A11E47D7 "owner()(address)" --rpc-url https://rpc.mainnet.chain.robinhood.com
```

The printed RPC is the chain's public RPC. The answer may be cached for 60 seconds.
