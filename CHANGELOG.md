# Changelog

All notable changes to this project. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Security issues still open are listed in [SECURITY.md](SECURITY.md).

## [Unreleased]

Fixes from the 2026-11-01 review of `0.1.0` (commit `aba0779`). `contracts/src` has changed since the review (see "Contracts" below) and needs a re-audit and a new deploy before these changes are live.

### Contracts
- **M-1:** a deposit is refused with `DepositPriceTooOld(asset, age)` while any held non-USDG asset's feed is more than 12 hours old (`CoferPot.MAX_DEPOSIT_PRICE_AGE`, read through the new `CoferFactory.priceUpdatedAt`). Groups holding stocks cannot deposit at weekends, on holidays and late at night; the USDG feed and exits are not affected. `/deposit` and the signer page say so before anything is signed. The 12 hours come from 14 days of feed history; the remaining after-hours risk is accepted in SECURITY.md.
- **H-2:** every non-unanimous vote, swaps included, now waits `guardDelay` before it runs, so members who disagree can exit before a majority's swaps. Unanimous swaps still run at once; a queued swap's price checks run again when it executes. The bot explains the wait after `/buy` and `/sell` and suggests a higher `slip=` for queued swaps.
- **L-1:** a `PAY_PLAN` vote now carries `maxCost` (`(uint8 months, uint256 maxCost)`); the pot refuses with `PlanCostAboveMax(cost, maxCost)` if months x the current plan price is higher. `/plan` sets it to today's price x months, and the summary shows it.
- The upstream sources of the vendored `Clones` and `FullMath` libraries are named exactly in their comments; `bytecode_hash` (ipfs) and CBOR metadata are pinned in the build settings.

### Security
- The signer API's `pot.get` and `pot.previewExit` now answer only an active member of that pot. Before, any signed-in member could read any pot's rules, holdings and exit amounts. Anyone else, and a pot that does not exist, get the same "group account not found", so the answer does not reveal whether a pot exists; the check runs before any chain read.
- `/send @user` and `/allowance @user` (2026-11-05 review, M-1): the username is now matched exactly, and only among this group's active members with a key. Before, the lookup was a pattern match where `_` matched any character, so a look-alike username (for example `bobxsmith` for `@bob_smith`) could be chosen and shown to voters under the typed name. The vote now shows the username stored for that key, and a name that matches more than one member is refused. To send to someone outside the group, use their 0x address.
- Only a group admin can open the group account with `/newpot` (2026-11-05 review, L-2). Before, any member with a key could open the group's single account first and become its only founding member. An admin with "Remain anonymous" on is asked to turn it off for this command, because their role cannot be checked while they post as the group. The check runs before anything is paid for.
- A vote withdrawn on the contract (`revokeVote`) can no longer be signed again through the signer site (2026-11-05 review, L-1). The contract never counts it again, but the services used to, so a vote could show as passed and then fail to run. The pot is asked directly, so a withdrawal made before the first signature is caught too.
- Cards are off by default (`CARD_ADAPTER=off`). The stub card adapter runs on testnet (46630) only, needs an explicit funding address and refuses burn addresses; `/card` is hidden when no adapter runs. Previously, card loads on mainnet were sent to a burn address.
- Only the member who asked for a card quote can confirm that card order.
- The group and the ops chat are told when a vote the bot did not create is queued or executed, with the time it can run and a reminder that `/exit` is open.
- The signer page checks every vote before the passkey is asked for: domain and chain, digest against the vote link, the server's action against the signed bytes, deadline, and on-chain that the contract is a real pot. Members tap "Check this vote", read a summary built from the exact bytes with full addresses, then approve; the page signs only the typed data it built.
- The signer page runs no inline script: its policy is `script-src 'self'`, settings travel in a JSON data block, and the phone notice moved into the page bundle. A vote-check refusal records its exact reason in the browser's console; members still see only the fixed text.
- Onboarding links (which bind a key to a Telegram account) are sent only by private message, never into a group, and the signer API refuses any onboarding link not made for a private chat.
- `/newpot` is limited to 2 new group accounts per Telegram user per 24 hours, checked before the relayer sends anything.

### Added
- Team bot on the existing alert bot, mainnet only (`TEAMBOT_ENABLED=1` on chain 4663): one launch update every hour in the staff group. Each one goes out only after its checks pass (status checked, both posters, its changelog line on main, its GitHub release). At its hour the draft release is published and two copy-ready posts follow (square poster with the Telegram text, wide poster with the X text). An update that fails a check is held with plain reasons, never posted, and the next stays on time. A pinned launch board is edited in place, staff-group commands are read-only (`/status`, `/next`, `/schedule`, `/poster`, `/changelog`, `/roadmap`, `/contracts`, `/socials`, `/videos`, `/video`, `/health`, `/help`), and pause, resume, hold, release, verify, arm, preflight and test run from the server only (`cofer-release`). Updates and posters are read from a private folder outside the repo. Guide: [docs/teambot.md](docs/teambot.md).
- Passed votes say when they will run in plain words, with the group's real exit window (the pot's setting, read where the text is built) and the time in UTC: "Passed. It will be done in 6 hours, at 11:06 UTC on 8 Nov 2026. Disagree? /exit takes your exact share any time." Replaces "Executes after <date>" on the vote card, "It executes after the exit window" on the signer page, "It can run after" in the group message for votes made outside the bot, and "exit window until" on the dashboard proposal row. A vote every member approved still says "Done." No vote, signing or contract logic changed.
- Signer page: after the passkey is used for a deposit, exit, claim, spend or card load, "Sending... this can take up to a minute. Keep this page open." is shown and the button stays off until it ends. A spend above what is left of the member's allowance (read from the pot's `memberInfo`, same math as `allowanceLeft`) is refused before the passkey is asked for, with the amount left ("You have 12.5 USDG left this day."); if that read fails the page carries on as before. Known contract refusals (for example `AllowanceExceeded`, `NoAllowance`, `InsufficientBalance`, `InsufficientShares`, `NothingOwed`) are shown as plain sentences, all mapped by error selector in `services/src/core/refusals.ts` and listed in docs/runbook.md; anything else still shows "Something went wrong. You can try again." No hex, URL or key is ever shown.
- A statement from the owner, headed "Before you start" and "Read This Statement": what Cofer is, that the bot never holds keys or money, Robinhood Chain only, exit always open (to your own address or one you type), no passkey recovery, and the beta limit. Sent as plain text on /start in the private chat, above the key set-up button, for new and linked members; the last line of /help points to it. One shared text (`services/src/core/notice.ts`) with the beta limit and network name taken from the code; the staff copy is in docs/runbook.md. No new command.
- Exit to a different address (signer page). The exit page has a collapsed option "Send to a different address"; the default is still the member's own key. The address can only be typed on the page, never taken from a link, the URL or the dashboard. It is refused with a plain reason if it is not a valid address, or is the zero address, the group account itself or any other group account, the factory, the fee router, the swap adapter, USDG or a listed Stock Token. The page shows the full address in groups of four, warns twice that only a wallet that supports Robinhood Chain may be used, and needs a confirmation box. Exits now take two taps: "Check my exit" shows "You are signing" with the destination and "Network: Robinhood Chain", and the page refuses to send if the call's destination, shares or pot differ from it (passkey and browser wallet alike). A token that cannot be sent is set aside for the destination address. No contract change.
- The sign-up screen warns, before the passkey is created, that a lost passkey with no backup cannot be recovered; the same words are in SECURITY.md (accepted risks) and docs/runbook.md.
- Dashboard phase 2a: **Deposit**, **Spend allowance**, **Claim set-aside token**, **Exit with my share** and **Approve / review** on a pending proposal. Each opens the existing signer page in a new tab with the same one-time link the bot makes, made by the server for the session's own member and pot only; the dashboard itself never signs. A button that cannot work now is disabled with a plain reason (deposits closed, a stock price older than 12 hours, beta limit reached, no allowance or allowance used up, nothing set aside, proposal executed, expired or already approved). Exit is never disabled. Other actions show a hint such as "Use /send in the group". Plan for creating proposals from the dashboard (phase 2b, not built): [docs/dashboard-phase-2b.md](docs/dashboard-phase-2b.md).
- Read-only dashboard, phase 1 (dashboard.getcofer.com, testdashboard.getcofer.com; [docs/dashboard.md](docs/dashboard.md)). A private **Open dashboard** button on `/me` and `/pot` (no new command) opens it with a one-time link, exchanged once for a 30-minute read-only session. It shows only the member's own group accounts: value, holdings with live prices from the factory, members, proposals with pending, confirmed and failed states, activity and the exit window. Amounts stay exact integers end to end. It cannot sign, vote or create anything. One build serves testnet and mainnet; the network settings come from a `config.json` on each server and the new `DASHBOARD_URL` setting. getcofer.com is unchanged.
- `LICENSE` (MIT) and `SECURITY.md`: how to report a problem, roles and who holds them, accepted risks with reasons, open issues.
- README: a deploy guide from a fresh clone; rule 3 now describes the owner Safe, the guardian and the fee sinks accurately.
- CI: a TruffleHog secret scan, and Dependabot updates for GitHub Actions.
- Alerts for every admin change on `CoferFactory` and `FeeRouter` (ownership, guardian, pauses, listings, feeds, adapters, fees, sinks, plan price) in the ops chat; queued feed, adapter and fee changes are also announced in every group with the time they can apply. The keeper checks every 5 minutes that the owner and guardian match `EXPECTED_OWNER` / `EXPECTED_GUARDIAN` and that no ownership transfer is pending (FeeRouter ownership changes emit no events).
- A read-only post-deploy check (`bun run check-deploy <manifest>`): live code against the local build, wiring, roles (including the Safe's 2-of-3), settings and listed assets, from `contracts/deployments/4663.json`; exits with an error on any mismatch.
- Tests: a stateful invariant suite on `CoferPot` (100,000 random calls: share and set-aside accounting, solvency, exits never revert), negative tests for every owner and guardian function and every pot entry point, and for every signer API route and the Telegram webhook.
- `docs/`: architecture with a roles matrix of every privileged function, invariants each linked to the test that checks it (untested ones marked), a threat model with what Cofer does not protect, and a pause runbook.

### Changed
- Staff alerts have a new look: "🟡 ALERT · name", a blank line, "What happened:", "Who acts:", then the link. Cleared alerts read "🟢 CLEARED · name (note)". role-changed uses 🔴 and its "Who acts" reads "Tell the owner and the dev at once."; the word EMERGENCY is no longer in the text, and a 🔴 alert still repeats every 30 minutes. Alerts posted in the earlier format still clear and repeat normally ([docs/alerts.md](docs/alerts.md)).
- CI: the contracts job skips deploy scripts in the size check, so `forge test` runs.
- CI: every action is pinned to a commit SHA, the job token is read-only, and checkouts do not keep credentials.
- Bun is pinned to 1.4.4 (`packageManager` in `services/package.json`, also used by CI); `@zerodev/*` are pinned to exact versions.
- Installs: no package may run install scripts (`trustedDependencies: []` for Bun, `ignore-scripts` for npm in `contracts/`), and Bun skips package versions less than 3 days old. `contracts/package-lock.json` is now committed.

### Fixed
- Vote cards are posted again. Every card was refused by Telegram with `BUTTON_DATA_INVALID` because its Approve / review and Details buttons carried the full proposal id (71 bytes; Telegram allows 64), so no card ever appeared in a group. The buttons now carry the id in a 43-character form (48 bytes), and a strict Telegram stand-in in the tests (`services/test/strictTelegram.ts`: button data, text length, https urls) fails any future message Telegram would refuse. `services/scripts/repost-card.ts` queues the card again for a vote whose card never appeared; it sends no transaction.
- Key setup with a passkey works again on the signer page. Since the exit-destination change (`481f153`), every new key was refused with "What was about to be signed does not match what was shown. Nothing was sent.": the call-data check looked for the account address inside the encoded call, but the Kernel account sends a single call to itself unwrapped (empty call data for key setup). That case now has to match the call data exactly. Nothing had been sent. A new test runs every passkey call shape (key setup, deposit, exit, spend, claim) through the real account encoder.

## [0.1.0] - 2026-10-31

The reviewed version (commit `aba0779`).

### Contracts
- `CoferPot` (one EIP-1167 clone per group): deposits at NAV, in-kind exits that are never gated, allowance spends, EIP-712 votes with an exit window for non-unanimous votes, and oracle-bounded swaps.
- `CoferFactory` (registry, 48h-timelocked feed, adapter and fee changes, entry-only pauses), `FeeRouter`, `UniV3SwapAdapter`.
- Testnet deploy script using the repo's own mocks; a mainnet fork test for buys and sells through the real router.

### Signer site and keys
- Passkey smart-account keys, one per Telegram account, that cannot be replaced once linked; the picked key is checked before any member action.
- One-time signer links spent only on tap; personal links delivered as ephemeral messages or DMs, and cancelled if ever shown to a whole group.
- Fixed, safe error text in the API and page; the page gets a public RPC only, never the server's.

### Stocks and swaps
- Canonical Stock Token list from the issuer's public API; non-tradable stocks skipped.
- Quotes across all Uniswap fee tiers with a gas cap; real pool depth required for buys, sells and new listings.
- New buys of a stock paused during a pending corporate action; selling and exit never paused.
- Beta deposit limit of 5,000 USDG per group, checked before signing.

### Operations
- Keeper alerts (once when a problem starts, once when it clears) for feeds, the relayer balance, indexer lag, failed votes and failed jobs, through an optional separate alerts bot; an optional outside health check ping.

### Telegram
- Plain bot only: any Telegram call that would add a Mini App is refused on every bot client.
- At most 18 messages a minute per group, shared across processes, with a soak test.

[Unreleased]: https://github.com/coferdev/cofer/compare/aba0779...HEAD
[0.1.0]: https://github.com/coferdev/cofer/tree/aba0779
