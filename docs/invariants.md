# Invariants

Each rule links to the test that checks it, as `file` › `test name`. A rule with no test yet says so;
it is not claimed as checked. Run the contract tests with `cd contracts && forge test -vv` and the
service tests with `cd services && bun test`.

## Contracts

| # | Invariant | Checked by |
| --- | --- | --- |
| C1 | Exit is never gated: pauses, delisting and stale feeds do not block `exit`. | `contracts/test/CoferPot.t.sol` › `test_exitNeverGatedByPausesOrStaleFeeds` |
| C2 | An exit pays exactly `floor(distributable x shares / totalShares)` of every held asset. | `contracts/test/CoferPot.t.sol` › `test_exitInKindProRata`, `test_exitRoundsDownInFavourOfPot` |
| C3 | A token that refuses the exit transfer is set aside for the member; the other assets still go out. | `contracts/test/CoferPot.t.sol` › `test_exitWithPausedTokenCreditsOwedAndOthersStillPaid` |
| C4 | Deposits and exits never pay out more than was put in. | `contracts/test/CoferPot.t.sol` › `testFuzz_depositsAndExitsNeverOverpay` (stateless fuzz, USDG only) |
| C4a | A deposit is refused while any held non-USDG asset's price is more than 12 hours old; the USDG feed and USDG-only pots are not age-checked; exits never are. | `contracts/test/CoferPot.t.sol` › `test_depositRefusedWhenHeldStockPriceOlderThanLimit`, `test_depositOkWithFreshStockPriceAndDayOldUsdgPrice`, `test_usdgOnlyPotDepositsIgnoreFeedAges`, `test_exitWorksWhileDepositsAreClosedByPriceAge`; `services/test/depositGate.test.ts` › `the bot and the signer page check before any link or passkey` |
| C5 | Total shares equal the sum of member shares, over any sequence of actions. | `contracts/test/invariant/CoferPotInvariants.t.sol` › `invariant_potAccountsAndExitsHold` (stateful: 1,000 runs x 100 calls) |
| C6 | The pot never owes more than it holds: for every asset, `reserved <= balance` and `reserved` equals the sum owed, over any sequence of actions. | `contracts/test/invariant/CoferPotInvariants.t.sol` › `invariant_potAccountsAndExitsHold` |
| C6a | Exit and leave never revert, over any sequence of deposits, exits, votes, swaps, price moves, token pauses, claims and time passing. | `contracts/test/invariant/CoferPotInvariants.t.sol` › `invariant_potAccountsAndExitsHold`; the actions really run: `test_handlerActionsTakeEffect` |
| C6b | Solvency: what every member would receive on exit, summed, never exceeds what the pot can pay out. | `contracts/test/invariant/CoferPotInvariants.t.sol` › `invariant_potAccountsAndExitsHold` |
| C6c | Every owner and guardian function refuses anyone else; every bounded setting refuses out-of-range input; every pot entry point refuses unauthorized callers and bad input. | `contracts/test/Negative.t.sol` › `test_factory_everyOwnerFunctionRefusesOthers`, `test_feeRouter_everyOwnerFunctionRefusesOthers`, `test_pot_memberOnlyFunctionsRefuseOthers`, `test_pot_votesRefuseOutOfRangeSettings` |
| C7 | Only members can deposit; a member cannot exit more shares than they have. | `contracts/test/CoferPot.t.sol` › `test_nonMemberCannotDeposit`, `test_exitMoreThanSharesReverts` |
| C8 | Allowance spends need no vote and are capped per member per period. | `contracts/test/CoferPot.t.sol` › `test_allowanceSpendNoVoteAndWeeklyReset`, `test_spendWithoutAllowanceReverts` |
| C9 | Every other move needs `requiredVotes()` distinct current members' signatures over this exact proposal. | `contracts/test/CoferPot.t.sol` › `test_transferNeedsThresholdAndWaitsGuardDelay`, `test_unsortedOrDuplicateSignersRevert`, `test_nonMemberSignerReverts`, `test_signatureForOtherProposalRejected` |
| C10 | A non-unanimous vote, swaps included, waits `guardDelay`, and dissenters can exit in full in that window; a unanimous vote runs at once. | `contracts/test/CoferPot.t.sol` › `test_transferNeedsThresholdAndWaitsGuardDelay`, `test_dissenterCanExitDuringGuardDelay`, `test_unanimousSkipsDelay`, `test_majoritySwapWaitsGuardDelay`, `test_dissenterExitsInFullBeforeQueuedSwap`, `test_unanimousSwapRunsAtOnce` |
| C10a | A queued swap's oracle floor is checked against the price when it runs, not when it was signed. | `contracts/test/CoferPot.t.sol` › `test_queuedSwapRechecksPriceAtExecution` |
| C11 | A revoked vote does not count; an expired vote cannot run; a member, threshold or settings change cancels earlier votes. | `contracts/test/CoferPot.t.sol` › `test_revokedVoteDoesNotCount`, `test_expiredProposalReverts`, `test_epochBumpInvalidatesPendingProposals` |
| C12 | A removed member receives their exact share before removal. | `contracts/test/CoferPot.t.sol` › `test_removeMemberForceExitsExactShare` |
| C13 | A swap's signed `minOut` cannot be looser than the oracle floor, the pool must pay at least `minOut`, stale feeds and unlisted assets refuse. | `contracts/test/CoferPot.t.sol` › `test_swapRejectsLooseMinOut`, `test_swapRevertsIfPoolPaysLessThanMinOut`, `test_swapRevertsOnStaleFeed`, `test_swapToUnlistedAssetReverts` |
| C14 | Feeds already include the Stock Token multiplier; it is never applied twice. | `contracts/test/CoferFactory.t.sol` › `test_quoteUsesFeedAnswerOnlyEvenWithMultiplier` |
| C15 | Feed, adapter and swap-fee changes wait 48h; the swap fee is capped at 0.50%. | `contracts/test/CoferFactory.t.sol` › `test_feedTimelock`, `test_adapterTimelock`, `test_swapFeeCapAndTimelock` |
| C16 | Admin functions are owner-only; ownership moves in two steps; USDG cannot be made unbuyable. | `contracts/test/CoferFactory.t.sol` › `test_onlyOwnerAdmin`, `test_ownershipTwoStep`, `test_usdgCannotBeMadeUnbuyable` |
| C16a | A plan vote never pays more than the `maxCost` its members signed, whatever the plan price does after the vote. | `contracts/test/CoferPot.t.sol` › `test_payPlanRefusesAboveMaxCost`, `test_payPlanPaysLowerPriceUnderMaxCost` |
| C17 | The implementation and every pot can be initialised only once; pot addresses are bound to their creator. | `contracts/test/CoferPot.t.sol` › `test_implementationLocked`, `test_cannotReinitialize`; `contracts/test/CoferFactory.t.sol` › `test_saltBoundToCreator` |
| C18 | The swap adapter only follows a path from `tokenIn` to `tokenOut`, pays the caller, enforces `minOut` and leaves no approval. | `contracts/test/FeeRouterAndAdapter.t.sol` › `test_adapterRejectsMismatchedPath`, `test_adapterSwapsToCallerAndResetsApproval`, `test_adapterEnforcesMinOut` |
| C19 | Only pots can pay for a plan; fee sinks always sum to 100%. | `contracts/test/FeeRouterAndAdapter.t.sol` › `test_payPlanOnlyFromPots`, `test_sinksMustSumTo10000` |
| C20 | The digest members sign is byte-identical in the services and the contract. | `contracts/test/Parity.t.sol` › `test_hashProposalMatchesViem`; `services/test/proposal.test.ts` › `viem digest == compiled CoferPot.hashProposal() executed in an EVM` |

## Services

| # | Invariant | Checked by |
| --- | --- | --- |
| S1 | The signer page signs nothing until it has checked the vote: domain and chain, digest against the link, the server's action against the bytes, deadline. | `services/test/voteCheck.test.ts` › `server shows one recipient but the bytes pay another: refused`, `server swaps the bytes under the same vote link: refused (digest)`, `the page checks the vote and the pot before the passkey, and signs only its own typed data` |
| S2 | The bot is plain: no Mini App, `web_app` button or menu button can be sent, by any bot client. | `services/test/noMiniApp.test.ts` › `an inline web_app button`, `the menu button, in any form, and the other Mini App methods`, `the bot (shared with the notifier) and the alerts bot` |
| S3 | At most 18 messages a minute in any group, across processes. | `services/test/rateLimit.test.ts` › `18 messages go through; the 19th is held back with the wait until a slot frees`; `services/test/soak.test.ts` › `the busy group really was over budget (the limiter had work to do)` |
| S4 | One card per vote, even with simultaneous updates. | `services/test/cards.test.ts` › `two updates at the same moment: still one card (with the lock)` |
| S5 | A personal link shown to a whole group by mistake is deleted, cancelled and re-sent by DM. | `services/test/privateReply.test.ts` › `delivered to the WHOLE group by mistake: deleted, link cancelled, ops told, DM with a fresh link` |
| S6 | Onboarding links are DM-only; the API refuses any other. | `services/test/onboardAndNewpot.test.ts` › `the signer API refuses a group onboarding link for both preview and exchange, and writes nothing`, `the bot sends onboarding links only by DM, never through the group reply path` |
| S7 | A one-time link is spent once; one key per Telegram account, never replaced. | `services/test/links.test.ts` › `exchange spends the link once and gives a 1h session`, `linking a different address is refused and the first one stays` |
| S8 | Cards are off by default; the stub card adapter never runs off testnet; only the ordering member confirms an order. | `services/test/cardsGate.test.ts` › `cards are off by default, also on mainnet`, `the stub is refused on mainnet, even with a funding address`, `a member cannot confirm someone else's card order` |
| S9 | A vote the bot did not create is announced to the group and ops, once. | `services/test/unknownVotes.test.ts` › `an unknown queued vote tells the group when it can run and how to exit, and alerts ops`, `an event already recorded (indexer re-run) is not sent twice` |
| S10 | New buys pause during a corporate action; selling and exit never do. | `services/test/buyPause.test.ts` › `/sell, /exit, /claim, /send and /spend never check it` |
| S11 | A swap vote is built only from deep pools near the feed price, never from partial quotes. | `services/test/depth.test.ts` › `an RPC error at either size refuses, even if another tier is fine`, `pools that quote but none deep enough: too thin` |
| S13 | Every signed-in API route refuses a caller without a session (or with a one-time link instead), and refuses malformed input; the Telegram webhook refuses a request without the shared secret. | `services/test/routes.test.ts` › `the list covers every signed-in route of the router`, `public routes refuse a forged or malformed link`, `no secret header -> 401, wrong secret -> 401` |
| S12 | Each user can open at most 2 group accounts a day, checked before the relayer pays. | `services/test/onboardAndNewpot.test.ts` › `two pots per user per day, then a fixed refusal with the hours left`, `/newpot takes the slot before the relayer sends anything` |
