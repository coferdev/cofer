# Guide: check timelocks yourself

What the owner and the guardian of Cofer's contracts can and cannot change, which changes must wait 48 hours, and how
to read any queued change straight from the chain, with a block explorer or Foundry's `cast`. Nothing here needs the
Cofer website.

Mainnet addresses (from `contracts/deployments/4663.json`):

```bash
export RPC=https://rpc.mainnet.chain.robinhood.com
export FACTORY=0x5d03d53A5630ceCC545Be46635779094A11E47D7
export ROUTER=0x3a90EC4e5107BC2e86ACC1a4d576A2daE1478527
```

## Who can do what

| Who | Can | Cannot |
|---|---|---|
| Owner (the team's 2-of-3 multisig) | pause and unpause new deposits and new group accounts; list a token or make it buyable or not; **after a 48-hour wait**: change a price feed, turn on a swap adapter, change the swap fee; at once: turn a swap adapter off, change the plan price (a plan vote still never pays more than the cost members signed), change the fee wallets | move, freeze or block any group account's money; pause or block an exit; vote |
| Guardian | pause and unpause new deposits and new group accounts | everything else |
| Anyone | send a group's fees on to the fee wallets (`distribute`), send a set-aside token to its owner (`claimOwed`) | anything that changes a group account |

No pause, vote or price feed can stop `exit()`.

## The wait itself

```bash
cast call $FACTORY "TIMELOCK()(uint32)" --rpc-url $RPC
```

172800 seconds: 48 hours between queuing a feed, adapter or fee change and applying it. The swap fee can never be
set above:

```bash
cast call $FACTORY "MAX_SWAP_FEE_BPS()(uint16)" --rpc-url $RPC
```

## Read what is queued

A new price feed for a token (zero address = nothing queued; the last value is the earliest time it can apply):

```bash
cast call $FACTORY "pendingFeed(address)(address,uint32,uint64)" <token> --rpc-url $RPC
```

A swap adapter waiting to be turned on (0 = not queued):

```bash
cast call $FACTORY "pendingAdapterEta(address)(uint64)" <adapter> --rpc-url $RPC
```

A new swap fee (eta 0 = nothing queued):

```bash
cast call $FACTORY "pendingSwapFeeBps()(uint16)" --rpc-url $RPC
cast call $FACTORY "pendingSwapFeeEta()(uint64)" --rpc-url $RPC
```

The roles and settings in force now:

```bash
cast call $FACTORY "owner()(address)" --rpc-url $RPC
cast call $FACTORY "guardian()(address)" --rpc-url $RPC
cast call $FACTORY "swapFeeBps()(uint16)" --rpc-url $RPC
cast call $ROUTER "planPricePerMonth()(uint256)" --rpc-url $RPC
```

## Read the history

Every queued change is a log on the factory. On the explorer, open the factory, then **Logs**; or:

```bash
cast logs --address $FACTORY "FeedQueued(address indexed asset,address feed,uint32 maxStaleness,uint64 eta)" --from-block 107497957 --rpc-url $RPC
cast logs --address $FACTORY "SwapFeeQueued(uint16 bps,uint64 eta)" --from-block 107497957 --rpc-url $RPC
cast logs --address $FACTORY "AdapterQueued(address indexed adapter,uint64 eta)" --from-block 107497957 --rpc-url $RPC
```

The same list in plain words: `https://<signer site>/v1/admin/pending`. The ownership and pause flags with a command
for each: `https://<signer site>/v1/proof/ownership`.
