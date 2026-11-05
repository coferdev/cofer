# Cofer alerts: staff guide

Pin this in the staff group.

## How to read an alert

```
[cofer alert] price-stale-TSLA
TSLA price feed is past its limit (97h old, limit 96h). Deposits and swaps that need it are refused until it updates. Exits are not affected.
Who acts: Dev checks.
https://robinhoodchain.blockscout.com/tx/0x…
```

- First line: the alert's name. **(EMERGENCY)** after it means act now.
- Then what happened, then who acts. A link, when there is one, opens the transaction on the block explorer.
- Addresses are shown by role (owner Safe, guardian, fee wallet, relayer, factory, fee router, swap adapter) or token symbol. Anything else is shortened, like 0x1234…abcd.
- Each problem is posted once. When it ends you get one line: `[cofer alert] <name>: Cleared`.
- An emergency is posted again every 30 minutes until it clears, with how long it has been open.
- If nothing is needed from anyone, nothing is posted.

Members can always exit. No alert, pause or outage changes that.

## Emergencies

| Name | What it means | Who acts |
|---|---|---|
| role-changed | The owner, guardian, a fee sink, the swap adapter or the fee router's factory was changed to an address that is not the expected one. | **Tell the owner and the dev at once.** If nobody planned it, pause deposits (see the runbook). |

## Alerts

| Name | What it means | Who acts |
|---|---|---|
| relayer-low | The relayer is low on ETH. Passed votes may not run on their own. This is the only alert with a full address: the one to top up. | Top up the relayer. |
| vote-stuck | A passed vote failed to run. | Dev checks. |
| vote-unknown | A vote that was not made through the bot was queued or ran. The group was told. | Dev checks. If nobody in that group made it, tell the owner and the dev at once. |
| price-stale-TSLA | That price feed is past its limit, so deposits and swaps that need it are refused. Stocks have a 96-hour limit, so normal weekends and holidays do not trigger it. USDG has a 24-hour limit and its feed updates every 24 hours plus up to about 30 seconds, so price-stale-USDG is posted only once it is more than 5 minutes past its limit. | Dev checks. |
| price-bad-TSLA | That price feed reports a price the contract rejects. | Dev checks. |
| split-mismatch-TSLA | The price moved in a way the token's multiplier does not explain (a split counted twice or not at all). The bot pauses new buys of that stock until it clears. | Dev checks. If values look wrong, pause deposits. |
| indexer-behind | The indexer is more than 5 minutes behind the chain. The bot may show old numbers. | Dev checks. |
| job-failing | A background job failed 3 times in a row. | Dev checks. |
| admin-change | An expected admin change: a pause, a queued or applied feed, adapter or fee change, the plan price, or a role set to its expected address. | Nothing if it was planned. If not, tell the owner and the dev at once. After a pause, tell the groups. |

## Server and service health

| Name | What it means | Who acts |
|---|---|---|
| rpc-down | The chain connection has failed for 5 minutes or more. While it lasts, and for 5 minutes after, indexer-behind, job-failing and errors-spike are held back because the outage causes them. Emergencies are never held back. | Dev checks the RPC provider. |
| errors-spike | 20 or more errors logged in 5 minutes across the bot, API and jobs. Single errors stay in the log only. | Dev checks the log. |
| disk-low | Less than 10% disk space left on the server. | Dev frees disk space or adds disk. |
| memory-high | The server has used more than 90% of its memory for 5 minutes or more. | Dev checks the server. |

## Not posted (log only)

- "Close to its limit" price warnings. USDG updates once a day, so this would come up daily.
- Asset listing and buyable changes.
- Admin events from old blocks, on first start or while the indexer catches up.

## For the dev: settings

In the services `.env`:
- `OPS_CHAT_ID` is the staff group.
- `ALERT_BOT_TOKEN` is optional: a separate bot that sends alerts, so they still arrive if the main bot is down.
- `EXPECTED_OWNER`, `EXPECTED_GUARDIAN` and `EXPECTED_FEE_WALLET` decide what counts as expected. If one is not set, changes to that role are posted as admin-change and are never treated as emergencies.
- Explorer links follow `CHAIN_ID`. You can override them with `EXPLORER_URL`.
