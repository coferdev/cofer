# Security

## Reporting a problem

Email **security@&lt;your-domain&gt;** (placeholder: replace before launch). Please do not open a
public issue for anything that could put member funds or keys at risk. We aim to reply within
3 working days and to agree a disclosure date with you.

## Scope

- `contracts/src`: `CoferPot`, `CoferFactory`, `FeeRouter`, `UniV3SwapAdapter` and their libraries.
- `services/`: the bot, signer API and signer page, relayer, indexer, keeper and notifier.

Out of scope: third-party card providers, the bundler, paymaster and passkey server, the
Robinhood Chain RPCs, and Chainlink feeds.

## Roles

Every privileged function and who can call it is listed in [docs/architecture.md](docs/architecture.md);
attackers and what stops them are in [docs/threat-model.md](docs/threat-model.md); how to pause is in
[docs/runbook.md](docs/runbook.md).

| Role | Held by | What it can do | What it cannot do |
| --- | --- | --- | --- |
| Owner of `CoferFactory` and `FeeRouter` | 2-of-3 Safe multisig on Robinhood Chain, `0x5ACD09eAe4f160e2f2e2356e6eF0496EF6f0f064`. It takes over from the deployer by calling `acceptOwnership()` on both contracts after deploy. | Pause or unpause new deposits and new pots. List assets, and set assets buyable or not (immediate). Queue feed, swap-adapter and swap-fee changes (48h timelock), and remove an adapter (immediate). Replace the guardian. On `FeeRouter`: set the plan price (immediate, capped at 100 USDG a month) and set the fee sinks and split. | Move, freeze or gate a pot's funds. Block or pause an exit. Vote in a pot. |
| Guardian | A single wallet | Pause or unpause new deposits and new pots. | Everything else. Exits are never pausable. |
| Fee sinks (all four: work, treasury, perks, burn) | The same single wallet as the guardian | Receives swap fees and plan payments when anyone calls `FeeRouter.distribute`. | Anything in a pot. |
| Members of a pot | Each member's own key (passkey smart account or browser wallet) | Deposit, exit, leave, spend their own allowance, revoke their vote, and sign votes. | Move pot funds without the vote threshold. |
| Relayer | A hot key in the services | Pays gas to submit `execute()`, which anyone may call, and `createPot` for `/newpot`. | Move funds. It holds only gas money. |

Notes on these choices:
- Because all four fee sinks are one wallet, the 80/10/5/5 split in `FeeRouter` has no effect
  on-chain. What happens to the "perks" and "burn" shares is decided by whoever holds that wallet.
- If the single guardian/sink key leaks, an attacker can pause new deposits and new pots, and
  can take fees already distributed to it. Exits keep working, and the owner multisig can
  unpause and replace the guardian. Member funds in pots are not reachable from either role.

## Accepted risks

- **The signer site decides what each passkey signs** (audit finding M-2).
  Member passkeys are bound by WebAuthn to the signer site's domain, and the signing page is
  served by the studio's API. Whoever controls that site or its build could show one action and
  ask the passkey to sign another, for example an exit to a different address.
  *Reason:* every passkey wallet that runs in a web page has this property, and passkeys are what
  make the product usable without a seed phrase.
  *What limits it:* before any passkey prompt, the signer page rebuilds the vote itself
  (`services/src/core/signCheck.ts`). It checks the Cofer v1 domain and chain, that the digest
  equals the vote in the member's link, that the server's decoded action matches the bytes, that
  the deadline has not passed, and on-chain that the contract is a real pot (`isPot`). It then
  shows a summary rendered from those exact bytes, with full addresses, and signs only the typed
  data it built. This protects against tampered server data (database or API).
  *Still open:* a replaced page script could skip these checks. Closing that needs the script
  served from a fixed, versioned location with an integrity hash. Members who prefer can use
  their own browser wallet, which shows the typed data it signs.
- **Exits are in kind.** A member who exits receives their exact share of every asset the pot
  holds, as it is; nothing is converted for them.
  *Reason:* this keeps exits free of oracles, votes and pauses, so they cannot be blocked.
- **After-hours price moves within the 12-hour deposit limit** (what remains of audit finding M-1).
  Deposits are priced at the oracle price. The stock feeds on Robinhood Chain update when the
  price moves (with about a one-day heartbeat), and not while the US market is closed, but the
  tokens trade at any time. A deposit is refused once a held stock's price is more than 12 hours
  old, which closes every weekend and holiday and the later part of each night. Within those
  12 hours, a large after-hours move (for example on earnings) can make the oracle price differ
  from the market by more than the 0.5% entry spread; a member who deposits then and exits in kind
  takes that difference from the other members.
  *Reason:* the 14 days of feed history read on 2026-11-01 show that a tighter limit closes
  deposits in normal trading: at 1 hour, groups holding AAPL could not deposit for 52% of market
  hours and groups holding SPY for 91%. At 12 hours, groups holding AAPL, TSLA or NVDA are never
  closed in market hours. Groups holding SPY, whose feed updates about every 10 hours even in
  market hours, are closed for about 31% of market hours.
  *What limits it:* the gain is bounded by how far the price moved after the close, less the
  entry spread, and by the deposit size (the beta limit is 5,000 USDG per group, enforced by the
  bot and signer page, not the contract). Raising a group's entry spread (up to 2%) narrows it further.

## Known open issues (not accepted, waiting for the owner)

None. The audit's contract findings are fixed in code (below) and wait for the owner's re-audit.

## Fixed in code, pending re-audit

These changes are in `contracts/src` after the reviewed version (`v0.1.0`, commit `aba0779`). They are not live until the owner's re-audit and a new deploy.

| ID | Issue | Fix | Checked by |
| --- | --- | --- | --- |
| H-2 | Swaps skipped the exit window, so a colluding majority could run many swaps in one transaction through pools they control and drain the minority. | Every non-unanimous vote, swaps included, now waits `guardDelay`; a queued swap's price checks run again when it executes. Unanimous swaps still run at once. | `contracts/test/CoferPot.t.sol` › `test_majoritySwapWaitsGuardDelay`, `test_dissenterExitsInFullBeforeQueuedSwap`, `test_queuedSwapRechecksPriceAtExecution`, `test_unanimousSwapRunsAtOnce` |
| M-1 | Deposits were priced on stock feeds up to 4 days old, so a member could deposit at a stale price (for example over a weekend) and exit in kind at a profit. | A deposit is refused with `DepositPriceTooOld` while any held non-USDG asset's feed is more than 12 hours old (`MAX_DEPOSIT_PRICE_AGE`). The USDG feed keeps its normal limit; exits never check prices. What remains is listed under accepted risks. | `contracts/test/CoferPot.t.sol` › `test_depositRefusedWhenHeldStockPriceOlderThanLimit`, `test_depositOkWithFreshStockPriceAndDayOldUsdgPrice`, `test_usdgOnlyPotDepositsIgnoreFeedAges`, `test_exitWorksWhileDepositsAreClosedByPriceAge` |
| L-1 | The group-plan price was not part of the signed vote and had no timelock, so the owner could raise it between a vote and its execution. | A plan vote now carries `maxCost`; the pot refuses with `PlanCostAboveMax` if months x the current price is higher. A lower price is paid as is. | `contracts/test/CoferPot.t.sol` › `test_payPlanRefusesAboveMaxCost`, `test_payPlanPaysLowerPriceUnderMaxCost` |

## Audit history

| Date | Commit | Kind | Result |
| --- | --- | --- | --- |
| 2026-11-01 | `aba0779` | Full review of contracts and services | 2 High, 3 Medium, 1 Low. Fixes outside `contracts/src` are being applied; the issues above remain open. |
