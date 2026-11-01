# Changelog

All notable changes to this project. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Security issues still open are listed in [SECURITY.md](SECURITY.md).

## [Unreleased]

Fixes from the 2026-11-01 review of `0.1.0` (commit `aba0779`). `contracts/src` has changed since the review (see "Contracts" below) and needs a re-audit and a new deploy before these changes are live.

### Contracts
- **H-2:** every non-unanimous vote, swaps included, now waits `guardDelay` before it runs, so members who disagree can exit before a majority's swaps. Unanimous swaps still run at once; a queued swap's price checks run again when it executes. The bot explains the wait after `/buy` and `/sell` and suggests a higher `slip=` for queued swaps.
- **L-1:** a `PAY_PLAN` vote now carries `maxCost` (`(uint8 months, uint256 maxCost)`); the pot refuses with `PlanCostAboveMax(cost, maxCost)` if months x the current plan price is higher. `/plan` sets it to today's price x months, and the summary shows it.
- The upstream sources of the vendored `Clones` and `FullMath` libraries are named exactly in their comments; `bytecode_hash` (ipfs) and CBOR metadata are pinned in the build settings.

### Security
- Cards are off by default (`CARD_ADAPTER=off`). The stub card adapter runs on testnet (46630) only, needs an explicit funding address and refuses burn addresses; `/card` is hidden when no adapter runs. Previously, card loads on mainnet were sent to a burn address.
- Only the member who asked for a card quote can confirm that card order.
- The group and the ops chat are told when a vote the bot did not create is queued or executed, with the time it can run and a reminder that `/exit` is open.
- The signer page checks every vote before the passkey is asked for: domain and chain, digest against the vote link, the server's action against the signed bytes, deadline, and on-chain that the contract is a real pot. Members tap "Check this vote", read a summary built from the exact bytes with full addresses, then approve; the page signs only the typed data it built.
- The signer page runs no inline script: its policy is `script-src 'self'`, settings travel in a JSON data block, and the phone notice moved into the page bundle. A vote-check refusal records its exact reason in the browser's console; members still see only the fixed text.
- Onboarding links (which bind a key to a Telegram account) are sent only by private message, never into a group, and the signer API refuses any onboarding link not made for a private chat.
- `/newpot` is limited to 2 new group accounts per Telegram user per 24 hours, checked before the relayer sends anything.

### Added
- `LICENSE` (MIT) and `SECURITY.md`: how to report a problem, roles and who holds them, accepted risks with reasons, open issues.
- README: a deploy guide from a fresh clone; rule 3 now describes the owner Safe, the guardian and the fee sinks accurately.
- CI: a TruffleHog secret scan, and Dependabot updates for GitHub Actions.
- Alerts for every admin change on `CoferFactory` and `FeeRouter` (ownership, guardian, pauses, listings, feeds, adapters, fees, sinks, plan price) in the ops chat; queued feed, adapter and fee changes are also announced in every group with the time they can apply. The keeper checks every 5 minutes that the owner and guardian match `EXPECTED_OWNER` / `EXPECTED_GUARDIAN` and that no ownership transfer is pending (FeeRouter ownership changes emit no events).
- A read-only post-deploy check (`bun run check-deploy <manifest>`): live code against the local build, wiring, roles (including the Safe's 2-of-3), settings and listed assets, from `contracts/deployments/4663.json`; exits with an error on any mismatch.
- Tests: a stateful invariant suite on `CoferPot` (100,000 random calls: share and set-aside accounting, solvency, exits never revert), negative tests for every owner and guardian function and every pot entry point, and for every signer API route and the Telegram webhook.
- `docs/`: architecture with a roles matrix of every privileged function, invariants each linked to the test that checks it (untested ones marked), a threat model with what Cofer does not protect, and a pause runbook.

### Changed
- CI: the contracts job skips deploy scripts in the size check, so `forge test` runs.
- CI: every action is pinned to a commit SHA, the job token is read-only, and checkouts do not keep credentials.
- Bun is pinned to 1.4.4 (`packageManager` in `services/package.json`, also used by CI); `@zerodev/*` are pinned to exact versions.
- Installs: no package may run install scripts (`trustedDependencies: []` for Bun, `ignore-scripts` for npm in `contracts/`), and Bun skips package versions less than 3 days old. `contracts/package-lock.json` is now committed.

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
