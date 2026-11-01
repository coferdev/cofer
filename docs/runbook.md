# Pause runbook

## What a pause does, and does not do

| Switch | Who | Stops | Never stops |
| --- | --- | --- | --- |
| `setDepositsPaused(true)` on `CoferFactory` | Guardian wallet or the Safe | New deposits into every pot | Exits, leaves, `claimOwed`, allowance spends, votes |
| `setCreationPaused(true)` on `CoferFactory` | Guardian wallet or the Safe | New pots (`/newpot`) | Anything in existing pots |
| `setBuyable(asset, false)` on `CoferFactory` | The Safe only | New buys of one asset | Selling it, valuing it, exiting with it |
| `removeAdapter(adapter)` on `CoferFactory` | The Safe only | All swaps through that adapter | Exits and transfers |

Nothing pauses an exit. Tell members so in every message.

## When to pause

- A price feed is wrong, frozen or behaving oddly (keeper feed or continuity alerts).
- A token issuer announces an incident, or a Stock Token behaves unexpectedly.
- A suspected bug in the contracts or services, or a report to the security contact.
- Unusual on-chain activity: many swaps in one transaction, an unknown vote alert you cannot explain.

When in doubt, pause deposits first: it only stops new money coming in.

## How to pause

Set these once (read-only checks; nothing here signs):

```bash
export RHC_RPC=https://...            # mainnet RPC
export FACTORY=0x...                  # CoferFactory address
```

1. Check the current state:

   ```bash
   cast call $FACTORY "depositsPaused()(bool)" --rpc-url $RHC_RPC
   cast call $FACTORY "creationPaused()(bool)" --rpc-url $RHC_RPC
   ```

2. Pause, from the **guardian wallet** (fastest: one signer) or as a **Safe** transaction:
   - `CoferFactory.setDepositsPaused(true)`
   - `CoferFactory.setCreationPaused(true)` if new pots should stop too
   - From a hardware or browser wallet, use the explorer's "Write contract" page or the Safe Transaction Builder. Do not paste a private key into a terminal.

3. Check it took effect (both should print `true`), then tell the groups (below).

## How to unpause

Only after the cause is understood and fixed: call the same functions with `false`, check with
`cast call` as above, and tell the groups.

If the guardian key may be compromised, the Safe calls `setGuardian(<new wallet>)` first, then
checks `cast call $FACTORY "guardian()(address)" --rpc-url $RHC_RPC`.

## Telling members

Post in each affected group (the bot's ops chat lists them), and keep it factual:

> New deposits are paused while we check <short reason>. Your money is not affected: you can still
> /exit with your exact share at any time, and votes still work. We will post here when deposits reopen.

## Contacts

Fill these in before launch, and keep them current.

| Role | Who | How to reach them |
| --- | --- | --- |
| Safe signer 1 | _to fill in_ | _to fill in_ |
| Safe signer 2 | _to fill in_ | _to fill in_ |
| Safe signer 3 | _to fill in_ | _to fill in_ |
| Guardian wallet holder | _to fill in_ | _to fill in_ |
| Security contact | see [SECURITY.md](../SECURITY.md) | _to fill in_ |
| Services on-call | _to fill in_ | _to fill in_ |
