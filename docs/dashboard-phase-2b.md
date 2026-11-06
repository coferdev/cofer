# Dashboard phase 2b: creating proposals from the dashboard (plan only, not built)

Goal: let a member start the proposals that today only the group chat can start (send, buy, sell,
allowance, threshold and settings, plan) from the dashboard, through the same server code the bot
uses. The dashboard still never signs: creating a proposal only records it and returns the same
"Sign my vote" signer link the bot gives (phase 2a hand-off), and the group sees the same vote card.
No contract change.

## What exists today

- `services/src/services/proposals.ts` `createProposal(deps, { pot, action, proposerTg })` already
  holds the core: it reads the pot's rules, refuses stock buys for groups with members in excluded
  or undeclared regions, builds the EIP-712 typed data, stores the proposal and queues the group's
  vote card (`deps.notify`). Those checks are therefore already shared. Both the bot (`propose()` in `bot/bot.ts`) and the
  signer API (`proposal.create`, which refuses swaps) call it.
- Everything around it lives inside `services/src/bot/bot.ts` and depends on the Telegram context
  (`ctx`): parsing the command text, finding the pot from the chat, looking members up by handle,
  building a swap, the pre-checks, and the reply.

## What would have to be shared out of bot.ts

Move these into a new `services/src/services/proposalBuilders.ts` (no Telegram types), so the bot
and the dashboard call the same functions; the bot keeps only parsing and replying:

| Today in bot.ts | Shared function | Notes |
| --- | --- | --- |
| `buildSwap`, `oracleQuote`, swap tier choice and depth checks (`chooseTier`, `depthRefusal`, `depthTestSize`), `computeMinOut`, `queuedSwapNote` | `buildSwapAction(deps, pot, side, asset, amount, slipBps)` returning `{ action, note }` or a refusal | The riskiest part: price, depth and slippage rules must stay identical. |
| `findAsset`, `buyPause`, `continuityOpen` | `buyRefusal(deps, asset, now)` | New buys pause during a corporate action; sells never do. |
| `resolveMember` / `pickMember` (handle to address) | `memberByHandle(deps, pot, handle)` | The dashboard would offer a member picker from the pot's active members instead of typed handles, which removes look-alike handle risk entirely. |
| `parseSend`, `parseAllowance`, `parseBuy`, `parseSell` amounts | keep the parsers; the dashboard sends structured, already-typed fields | Amounts as decimal strings of raw units, checked server-side with the same limits. |
| `isUsdgUpdating`, `RPC_ERROR_TEXT` handling, `replyError` | `proposalErrorText(e)` | Same fixed texts for members. |
| `tokenCache`, `nameCache`, `tokenMetaSync`, `warmToken` (labels used in summaries) | a small shared token/name cache module | Summaries must read the same in the vote card and on the dashboard. |
| `chatRateLimit` | a per-member rate limit shared by both entry points | One budget per member, wherever they propose from. |

`createProposal` itself would not change. The new dashboard route would be
`POST /api/dashboard/proposals { pot, kind, ...typed fields }`: dashboard session only, the member
from the session (never from the body), active member of the pot, the shared builder, then
`createProposal`, then the same signer link as phase 2a for "Sign my vote".

## Risks and how to handle them

1. **Two places to start a vote, one set of rules.** Any drift between the bot's and the dashboard's
   checks (swap depth, slippage, buy pause, region, beta limit) is a real risk. Mitigation: one
   shared builder per kind, both entry points call it, and parity tests that run the same inputs
   through the bot and the route and compare the stored typed data byte for byte.
2. **Moving code out of bot.ts can change bot behaviour.** Mitigation: move first with no behaviour
   change, keep every existing bot test green (`botCommands.test.ts` and the swap/depth tests), then
   add the dashboard route as a separate change.
3. **Proposal spam and nonce use.** A web form is easier to repeat than a chat command. Mitigation:
   the shared per-member rate limit, a limit on open proposals per pot, and an idempotency key per
   form submit so a double click creates one proposal.
4. **Cross-site requests.** The route changes state, so it must accept only the dashboard session in
   the `Authorization` header (never a cookie), JSON bodies only, and no CORS. Keep it on the
   dashboard's own address.
5. **Group awareness.** Proposals made outside the chat must still post the vote card in the group
   (as `createProposal` already does through the notifier), naming who proposed it, so no one is
   surprised. Test that the card is posted.
6. **Stale screens.** The form may show old prices or balances. Mitigation: the server rebuilds the
   action from live reads at submit time (as the bot does) and shows the exact summary to sign; the
   signer page shows the decoded action before the passkey is asked.
7. **Swaps queue behind the exit window** (non-unanimous votes wait `guardDelay`). The dashboard must
   show the same `queuedSwapNote` the bot shows, so members understand the wait.
8. **Handles and look-alikes.** Use a picker of the pot's active members by address (with username
   when known), never free-typed handles, for send and allowance.
9. **Mobile and accessibility.** Forms with amounts and pickers need testing on real iPhone Safari
   and Android, as the handoff asks.

## Tests to write then

Parity (bot and dashboard produce identical typed data for the same inputs), authorization (missing
session, non-member, another member's id, malformed fields), idempotency and double submit,
concurrent proposals from two members, decimals (raw-unit strings past 2^53, token decimals 6 and
18), refusals with the bot's exact texts (buy pause, region, depth, slippage, beta limit, RPC down),
and that the group vote card is posted.

## Order of work

1. Extract the shared builders from bot.ts, no behaviour change; all bot tests green.
2. Add `POST /api/dashboard/proposals` for the simplest kinds first (send USDG, allowance), then
   settings and plan, then buy and sell last.
3. Dashboard forms with member pickers; testnet first, then the same build to mainnet.
