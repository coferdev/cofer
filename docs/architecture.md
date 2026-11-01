# Architecture

Cofer is a shared group money account on Robinhood Chain (4663), run from a Telegram group.
Funds live only in on-chain contracts. The services help members propose, sign and see votes;
they never hold member funds.

## Components

| Part | Where | What it does | Holds |
| --- | --- | --- | --- |
| `CoferPot` | `contracts/src/CoferPot.sol` | One EIP-1167 clone per group. Deposits (USDG, at NAV), in-kind exits, allowance spends, votes as EIP-712 signatures, oracle-bounded swaps. Not upgradeable. | The group's funds |
| `CoferFactory` | `contracts/src/CoferFactory.sol` | Creates pots. Registry of listed assets and their Chainlink feeds, allowed swap adapters, the swap fee. Pauses for new deposits and new pots. | Nothing |
| `FeeRouter` | `contracts/src/FeeRouter.sol` | Receives swap fees and optional plan payments, splits them to four sinks. | Fees until distributed |
| `UniV3SwapAdapter` | `contracts/src/SwapAdapter.sol` | The only contract a pot approves for swaps. Calls Uniswap SwapRouter02 `exactInput`; output always goes back to the pot. | Nothing |
| Bot | `services/src/bot/` | Plain Telegram bot (no Mini App). Commands, proposal cards, personal one-time links to the signer site. | Bot token |
| Signer API + page | `services/src/api/`, `services/src/web/` | Exchanges a one-time link for a 1h session; serves the signing page. The page checks every vote before the passkey is asked (`services/src/core/signCheck.ts`). | `LINK_SECRET` |
| Relayer | `services/src/relayer/` | Submits `CoferPot.execute()` (permissionless) and pays its gas. | Relayer key (gas only) |
| Indexer | `services/src/indexer/` | Reads chain logs (pots, factory, fee router) into Postgres; alerts on votes the bot did not create and on every admin change (queued feed, adapter and fee changes also go to every group). | Nothing |
| Post-deploy check | `services/scripts/check-deploy.ts` | Read-only: compares live code with the local build and live roles and settings with `contracts/deployments/4663.json`; fails on any mismatch. | Nothing |
| Keeper | `services/src/keeper/` | Scheduled jobs and ops alerts (feeds, relayer balance, indexer lag, failed votes and jobs, owner/guardian drift). | Optional alerts bot token |
| Notifier | `services/src/notifier/` | One card per vote in the group, edited in place; at most 18 messages a minute per group. | Nothing |
| Member key | Member's device | Kernel v3.1 smart account with a passkey (or a browser wallet). Signs votes; sends deposits, exits, spends and claims as userOps. | The member's seat |

## How things flow

**A vote** (send, swap, add/remove member, allowance, threshold, settings, plan):
1. A member runs a command (`/send`, `/buy`, ...). The bot builds the proposal, stores it, and posts a card.
2. Each member taps the card, gets a personal one-time link, opens the signer page, taps "Check this vote"
   (the page rebuilds and checks it), reads the summary built from the exact bytes, then approves with the passkey.
3. When enough members have signed, the relayer calls `execute()`. A non-unanimous vote (except a swap) is
   first queued for `guardDelay`, so anyone who disagrees can exit before it runs.
4. The indexer sees `ProposalQueued` / `ProposalExecuted` and the notifier updates the card. A vote the bot
   did not create is announced to the group and the ops chat.

**Deposit, exit, leave, spend, claim**: the member's own smart account sends the call as a userOp from the
signer page (gas paid by the paymaster). No vote, no relayer. `exit` and `leave` cannot be paused.

## Roles matrix

"Safe" = the owner, a 2-of-3 Safe on Robinhood Chain, `0x5ACD09eAe4f160e2f2e2356e6eF0496EF6f0f064`.
"Guardian" = a single wallet. The four fee sinks are that same wallet.

### `CoferFactory`

| Function | Who can call | Delay | Effect |
| --- | --- | --- | --- |
| `createPot` | anyone (the bot's relayer for `/newpot`) | none | New pot; blocked while creation is paused |
| `listAsset` | Safe | immediate | First listing of an asset with its feed and staleness limit (max 4 days) |
| `setBuyable` | Safe | immediate | Stop or allow new buys of an asset; USDG can never be made unbuyable |
| `queueFeed` / `applyFeed` | Safe | 48h | Change an asset's price feed or staleness limit |
| `queueAdapter` / `applyAdapter` | Safe | 48h | Allow a swap adapter |
| `removeAdapter` | Safe | immediate | Disallow a swap adapter (only reduces what pots can do) |
| `queueSwapFee` / `applySwapFee` | Safe | 48h | Change the swap fee (hard cap 0.50%) |
| `setDepositsPaused` | Safe or Guardian | immediate | Pause or unpause new deposits in every pot |
| `setCreationPaused` | Safe or Guardian | immediate | Pause or unpause new pots |
| `setGuardian` | Safe | immediate | Replace the guardian |
| `transferOwnership` / `acceptOwnership` | Safe / the pending owner | 2-step | Move ownership |
| `quote`, `valueInUsdg`, views | anyone | n/a | Read-only |

### `FeeRouter`

| Function | Who can call | Delay | Effect |
| --- | --- | --- | --- |
| `setFactory` | Safe (owner) | once only | One-time wiring to the factory |
| `setPlanPrice` | Safe | immediate | Monthly plan price, capped at 100 USDG. A plan vote carries `maxCost`, so a later rise makes the vote fail rather than overcharge. |
| `setSinks` | Safe | immediate | The four fee sinks and their split |
| `transferOwnership` / `acceptOwnership` | Safe / the pending owner | 2-step | Move ownership (no events emitted) |
| `payPlan` | a pot (after a `PAY_PLAN` vote, and only if price x months is within the vote's `maxCost`) | n/a | Pulls price x months USDG from the pot |
| `distribute` | anyone | n/a | Sends the router's balance of a token to the sinks |

### `CoferPot`

| Action | Who | Vote needed | Notes |
| --- | --- | --- | --- |
| `deposit`, `depositWithPermit` | a member | no | Closed by the group setting or the factory pause |
| `exit` | anyone holding shares | no | Never paused, no oracle; a refused token transfer is set aside (`claimOwed`) |
| `leave` | a member | no | Exits everything and gives up the seat |
| `spend` | a member with an allowance | no | Capped per member per period, USDG only |
| `revokeVote` | a member | no | Withdraws that member's signature from a vote |
| `claimOwed` | anyone | no | Always pays the account it is owed to |
| `execute` | anyone | the votes it carries | Runs or queues one of the 8 vote kinds below |

Vote kinds: `TRANSFER`, `SWAP` (no exit window; oracle floor), `ADD_MEMBER`, `REMOVE_MEMBER` (pays the removed
member their exact share first), `SET_ALLOWANCE`, `SET_THRESHOLD`, `SET_CONFIG`, `PAY_PLAN`. Member, threshold
and settings changes bump the epoch, which cancels every vote signed before them.

### Off-chain

| Secret / key | Where | What it can do if leaked |
| --- | --- | --- |
| Relayer key | services env | Spend the relayer's gas money. It cannot move pot funds. |
| `LINK_SECRET` | services env | Make signer links and sessions for any Telegram user. A session cannot move funds on its own: every money action still needs the member's own key. |
| Telegram bot token | services env | Speak as the bot in every group. |
| Webhook secret | services env | Send fake updates to the bot's webhook. |
| Alerts bot token | services env (optional) | Speak as the alerts bot in the ops chat. |
| Deployer key | used once at deploy | Owner until the Safe calls `acceptOwnership()`; no role after hand-off. |

## Outside dependencies

| Dependency | Trusted for | If it fails or misbehaves |
| --- | --- | --- |
| Chainlink feeds on RHC | Prices for deposits (NAV) and the swap floor | Stale or bad prices revert deposits and swaps; exits never use them. See open issue M-1 for stale-but-allowed prices. |
| Uniswap SwapRouter02 and pools | Executing swaps | `minOut` and the oracle floor bound each swap. See open issue H-2. |
| USDG and Stock Token issuers | The tokens themselves | An issuer can pause a token; exits set that token aside and pay the rest. |
| ZeroDev (bundler, paymaster, passkey server) | Sending member userOps; passkey set-up | Members can still use a browser wallet; votes can be submitted by anyone. |
| Telegram | Delivering commands, cards and links | Funds are unaffected; members can act on-chain directly. |
| Robinhood Chain RPCs | Reading the chain | The page uses a public RPC only; a failed read refuses rather than guesses. |
