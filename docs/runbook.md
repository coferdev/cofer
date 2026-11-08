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

## The statement members read

The bot sends this, as plain text, on /start in a private chat, above the key set-up button (new and
already linked members alike); the last line of /help points to it. The text lives in
`services/src/core/notice.ts`; the beta limit and the network name in it come from the code
(`BETA_DEPOSIT_CAP_USDG`, `NETWORK_NAME`). If a member asks what Cofer is, point them to it rather than
rephrasing it. This is the staff copy; a test keeps it equal to what the bot sends.

> Before you start
>
> "Read This Statement"
>
> Cofer is a shared money account for your Telegram group, on Robinhood Chain.
>
> • Your key: when you set up, Cofer creates an address for you on Robinhood Chain, protected by your passkey (Face ID or fingerprint). There is no seed phrase. This bot never holds your keys or your money.
> • Robinhood Chain only: send USDG to that address on Robinhood Chain only. Money sent on any other network will not arrive.
> • Leaving is always open: any member can /exit at any time and get their exact share. Nobody can block it, not even us.
> • Where it goes: your exit goes to your own Cofer address, or to a different address you type. That must be a wallet that supports Robinhood Chain. Many exchange deposit addresses do not.
> • Your passkey is your key. There is no recovery: if you lose it and have no backup, you lose access to your money, like a lost seed phrase. Make sure your phone or browser backs up your passkeys.
> • Cofer is in beta: each group is limited to 5,000 USDG while we test. Stocks can lose value. This is software for a group to manage its own money, not financial advice.

## Member help: lost passkeys and exits to another address

Nobody can recover a passkey or reverse an exit. Say so plainly. The sign-up screen tells members, before the
passkey is created:

> Your passkey is your key. There is no recovery: if you lose it and have no backup, you lose access to your funds, like a lost seed phrase. Make sure your phone or browser backs up your passkeys (for example iCloud Keychain or Google Password Manager).

- **Lost passkey, no backup:** the member's key and its share cannot be reached by anyone, including
  the studio. Do not promise more.
- **Exit sent to a wrong address:** it cannot be undone. The exit page shows the full destination and
  "Network: Robinhood Chain", and asks the member to confirm the address is theirs and supports
  Robinhood Chain.
- **A token was set aside during an exit to another address** (for example, its issuer paused it):
  it is kept for that destination address, not for the member's key, so `/claim` and the dashboard
  do not show it. Once the token works again, anyone can call `claimOwed(<token>, <destination>)` on
  the group account from the explorer's "Write contract" page; it always pays the destination. Paying
  the gas is the only cost.

## Member help: when a passed vote runs, and what the signer page says

**Passed votes that wait.** A vote that passes without every member waits the group's exit window
(the pot's own setting, read when the text is built). The vote card, the signer page and the group
message for a vote made outside the bot all say it the same way, with the real window and time:

> Passed. It will be done in 6 hours, at 11:06 UTC on 8 Nov 2026. Disagree? /exit takes your exact share any time.

The signer page says "Passed. It will be done in ..." without the last sentence; the dashboard
proposal row shows "It will be done in ...". A vote every member approved runs at once: its card says
"Done." The time is in UTC and rounded up to the next minute.

**Sending.** After the passkey (or wallet) is used for a deposit, exit, claim, spend or card load,
the page shows "Sending... this can take up to a minute. Keep this page open." and the button stays
off so it cannot be tapped twice. If a member closes the page at that point, the action may still
go through: ask them to check `/me` or `/pot` before trying again.

**Spend over the allowance.** Before the passkey is asked for, the page reads what is left of the
member's allowance from the group account. An amount above it is refused with, for example, "That
is more than your allowance. You have 12.5 USDG left this day." (or "this week" / "this period").
Nothing is signed. If that read fails, the page carries on; the contract refuses an amount over
the allowance anyway.

**Refusals.** When the group account refuses an action, the page shows a plain sentence instead of
an error code. They are all in `services/src/core/refusals.ts`:

| Contract error (selector) | What the member reads |
|---|---|
| `AllowanceExceeded` (`0xc45cb513`) | That is more than your allowance has left. Nothing was sent. |
| `NoAllowance` (`0xebf59ac8`) | You have no allowance in this group. The group can give you one with a vote. Nothing was sent. |
| `InsufficientBalance` (`0xf4d678b8`) | The group account does not hold enough for this right now. Nothing was sent. |
| `NotMember` (`0x291fc442`) | Your key is not a member of this group. Nothing was sent. |
| `ZeroAmount` (`0x1f2a2005`) | Enter an amount above 0. Nothing was sent. |
| `BadParam` (`0xde17a3af`) | That address or amount is not valid. Nothing was sent. |
| `DepositsClosed` (`0x1a8ade30`) | Deposits are closed for this group right now. Exiting is always open. Nothing was sent. |
| `DepositPriceTooOld` (`0x25301041`) | Deposits are closed until the stock price updates (markets closed). Exiting is always open. |
| `StalePrice`, `BadPrice` (factory) | A price this group needs is not available right now. Try again later. Nothing was sent. |
| `InsufficientShares` (`0x39996567`) | You have fewer shares than this exit asks for. Check /me in Telegram. Nothing was sent. |
| `NothingOwed` (`0x797dba54`) | Nothing is set aside for you in this group. |
| `TransferFailed` (`0x39f1c8d9`) | A token could not be sent right now (its issuer may have paused it). Nothing was sent. Try again later. |
| `TransferFromFailed` (`0x6e1c8d15`) | The USDG could not be taken from your key. Check that your key holds enough USDG. Nothing was sent. |

Anything else shows "Something went wrong. You can try again." (or, once the action was handed
off, "This may have gone through. Check /me or /pot in Telegram before trying again."). The full
error is only in that browser's console.

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
