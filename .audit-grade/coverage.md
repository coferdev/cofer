# Test coverage at `18f8b7a`

Measured on 2026-11-05 in a clean copy of the commit (no `.env`, installs with scripts off).

| Part | Lines covered | Command |
| --- | --- | --- |
| Contracts (`contracts/src`, without mocks) | **97.8%** (579 of 592) | `cd contracts && forge coverage --report summary --no-match-coverage "(test\|script\|mocks)"` |
| Services (files loaded by any test) | 89.66% | `cd services && bun test --coverage` |
| Services, in scope (weighted by code lines; files no test loads count as 0%) | **76.1%** of 4,869 code lines | see below |
| **Combined in scope** | **78.5%** | contracts + services, in scope |

**How the in-scope figure is worked out.** Each services file's line coverage is weighted by its number of code lines (blank lines, comments and imports left out). Left out of scope: the browser bundle of the signer page (`src/web/client.ts`, `src/web/buffer-polyfill.ts`) and the generated contract ABIs (`src/chain/abi/index.ts`). Files that no test loads count as 0%: `src/cards/CardAdapter.ts`, `src/index.ts`, `src/relayer/relayer.ts` (`src/cards/CardAdapter.ts` holds only types).

Stateful invariants (not line coverage): `invariant_potAccountsAndExitsHold` and `invariant_feeRouterConservesAndSplitsExactly`, each 1,000 runs x 100 calls = 100,000 calls, no failures. Mainnet fork tests: 10 of 10 (TSLA and NVDA) at block 107028773.

## Contracts, per file

|------------------+--------------+-------+---------+----------|
|------------------+--------------+-------+---------+----------|
|------------------+--------------+-------+---------+----------|
|------------------+--------------+-------+---------+----------|
|------------------+--------------+-------+---------+----------|
|------------------+--------------+-------+---------+----------|
|------------+--------------+-------+---------+----------|
|------------+--------------+-------+---------+----------|
|------------+--------------+-------+---------+----------|
|------------+--------------+-------+---------+----------|
|------------+--------------+-------+---------+----------|
|------------+--------------+-------+---------+----------|
|------------+--------------+-------+---------+----------|
|------------+--------------+-------+---------+----------|
|------------+--------------+-------+---------+----------|
|------------+--------------+-------+---------+----------|
|------------+--------------+-------+---------+----------|
|------------+--------------+-------+---------+----------|
|------------+--------------+-------+---------+----------|
| File                         | % Lines          | % Statements     | % Branches       | % Funcs         |
| src/CoferFactory.sol         | 95.31% (122/128) | 93.02% (160/172) | 74.19% (23/31)   | 92.00% (23/25)  |
|------------------------------+------------------+------------------+------------------+-----------------|
| src/CoferPot.sol             | 99.34% (299/301) | 96.53% (390/404) | 82.11% (78/95)   | 97.14% (34/35)  |
|------------------------------+------------------+------------------+------------------+-----------------|
| src/FeeRouter.sol            | 94.55% (52/55)   | 93.24% (69/74)   | 85.71% (12/14)   | 100.00% (10/10) |
|------------------------------+------------------+------------------+------------------+-----------------|
| src/SwapAdapter.sol          | 100.00% (19/19)  | 89.29% (25/28)   | 40.00% (2/5)     | 100.00% (3/3)   |
|------------------------------+------------------+------------------+------------------+-----------------|
| src/lib/Clones.sol           | 100.00% (14/14)  | 92.31% (12/13)   | 0.00% (0/1)      | 100.00% (2/2)   |
|------------------------------+------------------+------------------+------------------+-----------------|
| src/lib/FullMath.sol         | 100.00% (25/25)  | 96.55% (28/29)   | 50.00% (1/2)     | 100.00% (1/1)   |
|------------------------------+------------------+------------------+------------------+-----------------|
| src/lib/ReentrancyGuard.sol  | 100.00% (4/4)    | 75.00% (3/4)     | 0.00% (0/1)      | 100.00% (1/1)   |
|------------------------------+------------------+------------------+------------------+-----------------|
| src/lib/SafeTransferLib.sol  | 92.00% (23/25)   | 80.95% (34/42)   | 14.29% (1/7)     | 100.00% (5/5)   |
|------------------------------+------------------+------------------+------------------+-----------------|
| src/lib/SignatureChecker.sol | 100.00% (21/21)  | 85.71% (30/35)   | 28.57% (2/7)     | 100.00% (2/2)   |
|------------------------------+------------------+------------------+------------------+-----------------|
| Total                        | 97.80% (579/592) | 93.76% (751/801) | 73.01% (119/163) | 96.43% (81/84)  |

## Services, per file (loaded by tests)

| File | % functions | % lines |
| --- | --- | --- |
| `src/api/router.ts` | 73.08 | 79.79 |
| `src/api/server.ts` | 12.50 | 50.00 |
| `src/bot/bot.ts` | 85.25 | 92.38 |
| `src/bot/exitList.ts` | 100.00 | 100.00 |
| `src/bot/help.ts` | 100.00 | 100.00 |
| `src/bot/keyboards.ts` | 100.00 | 100.00 |
| `src/bot/newpotAdmin.ts` | 100.00 | 100.00 |
| `src/bot/newpotLimit.ts` | 100.00 | 100.00 |
| `src/bot/noMiniApp.ts` | 100.00 | 100.00 |
| `src/bot/parse.ts` | 100.00 | 100.00 |
| `src/bot/privateReply.ts` | 100.00 | 93.75 |
| `src/bot/rateLimit.ts` | 91.67 | 97.26 |
| `src/bot/resolveHandle.ts` | 100.00 | 100.00 |
| `src/cards/StubCardAdapter.ts` | 75.00 | 85.71 |
| `src/cards/select.ts` | 100.00 | 100.00 |
| `src/chain/abi/index.ts` | 100.00 | 100.00 |
| `src/chain/addresses.ts` | 100.00 | 100.00 |
| `src/chain/clients.ts` | 40.00 | 81.82 |
| `src/chain/quotes.ts` | 100.00 | 100.00 |
| `src/core/alertFormat.ts` | 100.00 | 100.00 |
| `src/core/betaCap.ts` | 100.00 | 100.00 |
| `src/core/buyPause.ts` | 100.00 | 100.00 |
| `src/core/continuity.ts` | 100.00 | 95.45 |
| `src/core/deployCheck.ts` | 97.37 | 95.33 |
| `src/core/depositGate.ts` | 100.00 | 100.00 |
| `src/core/depth.ts` | 100.00 | 100.00 |
| `src/core/errors.ts` | 100.00 | 93.75 |
| `src/core/feedHealth.ts` | 100.00 | 100.00 |
| `src/core/feedName.ts` | 100.00 | 100.00 |
| `src/core/geo.ts` | 100.00 | 100.00 |
| `src/core/indexerLag.ts` | 100.00 | 100.00 |
| `src/core/linkToken.ts` | 100.00 | 100.00 |
| `src/core/outflow.ts` | 100.00 | 100.00 |
| `src/core/priceUpdating.ts` | 100.00 | 100.00 |
| `src/core/proposal.ts` | 100.00 | 89.33 |
| `src/core/relayerFunds.ts` | 100.00 | 100.00 |
| `src/core/retryText.ts` | 100.00 | 100.00 |
| `src/core/roles.ts` | 100.00 | 100.00 |
| `src/core/serverHealth.ts` | 100.00 | 100.00 |
| `src/core/shares.ts` | 100.00 | 100.00 |
| `src/core/signCheck.ts` | 100.00 | 94.83 |
| `src/core/signerCheck.ts` | 100.00 | 100.00 |
| `src/core/swap.ts` | 100.00 | 100.00 |
| `src/core/telegramLogin.ts` | 100.00 | 100.00 |
| `src/core/valuation.ts` | 85.71 | 94.74 |
| `src/core/votes.ts` | 100.00 | 100.00 |
| `src/db/client.ts` | 0.00 | 54.55 |
| `src/db/schema.ts` | 0.00 | 96.30 |
| `src/env.ts` | 75.00 | 94.23 |
| `src/indexer/adminEvents.ts` | 100.00 | 98.06 |
| `src/indexer/indexer.ts` | 0.00 | 10.05 |
| `src/indexer/unknownVotes.ts` | 100.00 | 100.00 |
| `src/keeper/alerts.ts` | 54.55 | 55.67 |
| `src/keeper/health.ts` | 87.50 | 75.00 |
| `src/keeper/jobAlerts.ts` | 85.71 | 100.00 |
| `src/keeper/keeper.ts` | 30.95 | 45.55 |
| `src/keeper/serverHealth.ts` | 46.15 | 60.78 |
| `src/notifier/notifier.ts` | 75.00 | 41.07 |
| `src/queues.ts` | 36.36 | 50.00 |
| `src/relayer/voteAlerts.ts` | 100.00 | 100.00 |
| `src/services/proposals.ts` | 25.00 | 13.79 |
| `src/stocks/canonical.ts` | 83.33 | 90.00 |
| `src/web/page.ts` | 66.67 | 100.00 |
| `src/web/pageConfig.ts` | 100.00 | 100.00 |
