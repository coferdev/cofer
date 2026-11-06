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
- Unusual on-chain activity: many swaps in one transaction, an unknown vote alert you cannot explain, or a `large-outflow` alert that is not real member activity.

When in doubt, pause deposits first: it only stops new money coming in.

## Not a reason to pause: the daily USDG update

The USDG price limit is 24 hours, and the real USDG feed updates every 24 hours plus up to about
30 seconds. So for up to about 30 seconds a day, buys, sells and deposits into groups that hold a
stock are refused; exits are not affected. This is expected (see the accepted risks in
[SECURITY.md](../SECURITY.md)). While USDG is less than 5 minutes past its limit, the bot and the
signer page tell members "The price is updating, try again in a minute" instead of a market-closed
message. If a member reports a refusal at that moment, ask them to try again in a minute. A passed vote the relayer tries to execute in that window is tried again
automatically, normally within seconds; if all 5 quick tries fall inside the window, it runs about
5 minutes later and a `vote-stuck` alert may appear for it, which clears by itself once it runs. A USDG price that stays past its limit for minutes is a real feed problem: treat it like
any other feed alert.

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

## After any admin change

The indexer posts each admin change to the staff group as one `admin-change` line (listing and
buyable changes are logged only); queued feed, adapter and fee changes are also announced in every
group. A role or setting moved to an unexpected address is a `role-changed` emergency, posted again
every 30 minutes until it clears. The keeper also checks every 5 minutes that the owner and guardian
match `EXPECTED_OWNER` / `EXPECTED_GUARDIAN` and that no ownership transfer is pending to anyone else.
What each alert means and who acts: [alerts.md](alerts.md). After the change, update
`contracts/deployments/4663.json` if the expected values changed, and run the full check:

```bash
cd services && bun run check-deploy ../contracts/deployments/4663.json --rpc $RHC_RPC
```

An alert you cannot explain is an incident: pause deposits first, then investigate.

If the guardian key may be compromised, the Safe calls `setGuardian(<new wallet>)` first, then
checks `cast call $FACTORY "guardian()(address)" --rpc-url $RHC_RPC`.

## Collecting fees

Swap fees and plan payments stay in `FeeRouter` until someone calls `distribute(<token>)` on it.
Nothing calls it automatically. It sends the router's whole balance of that token to the four fee
sinks (all the guardian wallet, 80/10/5/5). A buy pays its fee in USDG; a sell pays it in the stock
sold, so the router can hold USDG and several stocks. Anyone may call it, and it can only pay the
sinks, so collecting is safe to do at any time; once a month is enough.

1. Check what is waiting (read-only; paste each line on its own):

   ```bash
   export FEE_ROUTER=0x...               # FeeRouter address
   cast call 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 "balanceOf(address)(uint256)" $FEE_ROUTER --rpc-url $RHC_RPC
   ```

   The first line is USDG (6 decimals: 1000000 is 1 USDG). Repeat it with each listed stock's
   address in place of the USDG address (Stock Tokens use 18 decimals: 1000000000000000000 is 1 token).

2. For each token with a balance above zero, call `FeeRouter.distribute(<token address>)` from the
   **guardian wallet** (any wallet works; it only pays gas) on the explorer's "Write contract" page,
   or as a Safe transaction. Do not paste a private key into a terminal.

3. Check again: the router's balance of that token is now 0.

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
| Security contact | see [SECURITY.md](../SECURITY.md) | coferproject@gmail.com |
| Services on-call | _to fill in_ | _to fill in_ |
