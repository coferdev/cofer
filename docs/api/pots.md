# Group accounts

Public facts about one Cofer group account, by its address. Only what the chain already shows: a group account is
never named by its Telegram group, and members are never named.

An address the factory did not make answers `404`; a malformed address answers `400`.

## GET /v1/pots/:pot

```bash
curl https://<signer site>/v1/pots/0x362B6794E6374b400aA186C1a67AC2c060af2E50
```

| Field | Meaning | Check it yourself |
|---|---|---|
| `memberCount` | active members | `memberCount()` |
| `voteRule.threshold`, `thresholdBps` | the vote rule: a share of members (basis points, rounded up) when `thresholdBps` is above 0, else the fixed count | `threshold()`, `thresholdBps()` |
| `voteRule.approvalsNeeded` | approvals a vote needs now, as the account counts them | `requiredVotes()` |
| `exitWindowSeconds` | how long a vote that not everyone approved waits before it runs, so members can exit first | `config()` |
| `depositsOpen`, `maxSlipBps`, `entrySpreadBps` | the rest of the account's settings | `config()` |
| `totalShares` | all shares (18 decimals) | `totalShares()` |
| `epoch` | goes up when membership changes (open votes then need signing again) | `epoch()` |
| `assets[]` | each token held: raw `balanceOf`, `distributable` (what exits share; the rest is set aside for claims) and `decimals` | `heldAssets()`, then `balanceOf` on each token and `distributable(token)` |
| `planPaidUntil` | unix time the plan is paid until, or `null` | the fee router's `planPaidUntil(pot)` |
| `createdBlock` | the block the factory created it in (from the indexer) | the factory's `PotCreated` log |

It may be cached for 30 seconds.

## GET /v1/pots/:pot/members

```bash
curl "https://<signer site>/v1/pots/0x362B…2E50/members?limit=50"
```

Each member by address only: `address`, `active` (false once removed or fully exited), `shares` (18 decimals) and
`joinBlock` (the block of their `MemberAdded` log). No names, usernames or Telegram ids.

Paged in address order: up to `limit` (1 to 200, default 50) per page; `next` is the `after` value for the next page,
`null` on the last. Check it yourself: `members()(address[])` and `memberInfo(address)` on the group account, and its
`MemberAdded` logs. It may be cached for 15 seconds.

## GET /v1/pots/:pot/votes

```bash
curl "https://<signer site>/v1/pots/0x362B…2E50/votes?state=queued"
```

A group's votes. `state` filters them: `open` (collecting approvals), `ready` (enough approvals, not sent yet),
`queued` (waiting for its exit window), `executed`, `expired`, `stale` (membership changed before it ran) or `failed`.
`limit` is 1 to 100 (default 50).

Each vote: `id` (its digest), `kind`, `state`, `summary`, `madeBy`, `createdAt`, `deadline`, `canRunAfter` (end of
the exit window, for a queued vote), `approvals` out of `approvalsNeeded`, and `txHash`.

- The summary is made again from the vote's own bytes, with full addresses and amounts only. It never names a member.
- Votes made outside the bot are included (`madeBy: "outside the bot"`), from the group account's `ProposalQueued`
  and `ProposalExecuted` logs; their full details are in their transaction. They are listed first, newest first,
  then the bot's votes, newest first.

Check it yourself: the group account's `ProposalQueued` and `ProposalExecuted` logs, and `requiredVotes()`.
It may be cached for 15 seconds.

## GET /v1/pots/:pot/timeline

```bash
curl "https://<signer site>/v1/pots/0x362B…2E50/timeline?limit=50"
```

Everything a group account did, in block order: deposits, exits, allowance spends, claims, votes queued and run,
sends, swaps, members added or removed, settings and plan payments. Each event has its `block`, `logIndex`,
`txHash`, `event` (the log's name), `kind`, `text` (the same plain words as the
[transaction explainer](tx.md)) and `args` (the log's fields, big numbers as decimal strings). Events it does not
describe are left out, never guessed at.

Paged oldest first by block and log index, `limit` 1 to 200 (default 50). `next` is the `after` value for the
following page (like `153947820-4`), or `null` when there is nothing newer yet. A page never changes when newer
events arrive. Check it yourself: `cast logs --address <group account> --from-block <block>`. It may be cached for
15 seconds.

## GET /v1/members/:address

Every group account where this key is an active member, with its `shares` there (18 decimals) and its `joinBlock`.
A key in no group answers an empty list. Check it yourself: `memberInfo(<key>)` on each listed group account. It may
be cached for 15 seconds.

## GET /v1/pots/:pot/holdings

```bash
curl "https://<signer site>/v1/pots/0x362B…2E50/holdings?from=2026-12-01&to=2026-12-31"
```

A group account's raw balance of each token, day by day, from the daily snapshots taken at the block nearest 00:00
UTC. Balances only: no price, value or total. Each day gives the `block` and `blockTime` it was read at, and
`balances` (`asset`, `symbol`, `decimals`, `rawBalance`). Without dates: the last 30 days; at most 366 days per request.
Check any day yourself: `cast call <token> "balanceOf(address)(uint256)" <group account> --block <block>` (an archive
RPC is needed for old blocks). It may be cached for 5 minutes.

## GET /v1/pots/:pot/fees

Every fee a group account paid, oldest first: the swap fee on each swap (`kind: "swap fee"`, in the token swapped
in; 0.30% today) and each plan payment (`kind: "plan"`, in USDG, with `months`). Each has `amount` (raw), `symbol`,
`decimals`, `block`, `logIndex` and `tx`. Paged like the timeline (`after`, `limit` 1 to 200, `next`). From the
[fee ledger](../ledgers.md). Check one yourself: the `fee` field of the transaction's `Swapped` log, or the
`PlanPaid` log. It may be cached for 15 seconds.

## GET /v1/pots/:pot/feed.atom and /feed.json

One group account's own feed, in Atom and JSON Feed: each deposit, exit, vote (passed and waiting, or run) and
allowance spend, newest first (the last 50), in the same plain words as the transaction explainer, each linking its
transaction page. Subscribe in any feed reader; nothing is stored about who subscribes. Item ids are fixed by
transaction and log, so a reader never shows one twice. It may be cached for a minute.
