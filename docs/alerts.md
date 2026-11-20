# Cofer alerts: staff guide

Pin this in the staff group.

## How to read an alert

```
🟡 ALERT · price-stale-TSLA

What happened: TSLA price feed is past its limit (97h old, limit 96h). Deposits and swaps that need it are refused until it updates. Exits are not affected.
Who acts: Dev checks.
https://robinhoodchain.blockscout.com/tx/0x…
```

- First line: the alert's name. 🟡 is a normal alert. **🔴 means act now** (role-changed).
- Then a blank line, what happened, and who acts. A link, when there is one, opens the transaction on the block explorer.
- Addresses are shown by role (owner Safe, guardian, fee wallet, relayer, factory, fee router, swap adapter) or token symbol. Anything else is shortened, like 0x1234…abcd.
- Each problem is posted once. When it ends you get one line: `🟢 CLEARED · <name>`, sometimes with the reason in brackets, like `🟢 CLEARED · vote-stuck (it executed)`.
- A 🔴 alert is posted again every 30 minutes until it clears, with how long it has been open.
- Alerts posted before this look (starting `[cofer alert]`) still clear and repeat normally.
- If nothing is needed from anyone, nothing is posted.

Members can always exit. No alert, pause or outage changes that.

## Act now (🔴)

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
| price-jump-TSLA | That price feed moved more than 20% (a Stock Token) or 2% (USDG) between two readings. Moves a split explains, and splits the issuer has announced, are left out. It clears at the next normal reading. Exits never use prices. | Dev checks the feed. If prices look wrong, pause deposits. |
| split-mismatch-TSLA | The price moved in a way the token's multiplier does not explain (a split counted twice or not at all). The bot pauses new buys of that stock until it clears. | Dev checks. If values look wrong, pause deposits. |
| indexer-behind | The indexer is more than 5 minutes behind the chain. The bot may show old numbers. | Dev checks. |
| job-failing | A background job failed 3 times in a row. | Dev checks. |
| large-outflow | More than 5,000 USDG worth left group accounts within the last hour (exits, voted transfers, allowance spends, plan payments and claimed set-aside tokens, across all pots; stocks at the oracle price). It names the largest pot and links the largest transaction. Exits are never paused by it. | Dev checks it is real activity. If it is not, pause deposits (runbook). |
| set-aside-waiting | A token set aside during an exit has waited more than 7 days unclaimed, and its claim would now go through (checked with a read-only simulation). Anyone can send the claim; the tokens go to the address they were set aside for. | Dev checks; tell the group so the owner of that address claims it (`/claim`, or `GET /v1/set-asides/<address>`). |
| admin-change-soon | A change queued behind the 48-hour timelock (a price feed, a swap adapter or the swap fee) can be applied by the owner within 6 hours. Posted once per change. | Nothing if it was planned. If not, tell the owner and the dev at once. |
| admin-change-due | That change's timelock has ended: the owner can apply it now. Posted once. Both are dropped without a post once it is applied or replaced (the applied change is posted as admin-change). | Same as above. |
| admin-change | An expected admin change: a pause, a queued or applied feed, adapter or fee change, the plan price, or a role set to its expected address. | Nothing if it was planned. If not, tell the owner and the dev at once. After a pause, tell the groups. |

## Server and service health

| Name | What it means | Who acts |
|---|---|---|
| signer-page-down | Every 5 minutes the keeper loads the passkey and wallet signing pages from the public address. One of them did not answer 200, lost its exact security policy or x-frame-options, does not load its script, or serves a script that is not byte for byte the one this release builds. The alert names which. Exits from the contract itself are not affected. | Dev checks the server and the last deploy. |
| rpc-wrong-chain | 🔴 The server's chain connection answers a different chain id from the one the services run for (checked every minute against the chain's public RPC). The bot, indexer and jobs may be reading the wrong chain. | **Tell the owner and the dev at once.** Fix RHC_RPC_URL and restart. |
| rpc-lagging | The server's chain connection has been more than 300 blocks behind the chain's public RPC for 5 minutes. Read-only check: nothing is re-routed. | Dev checks the RPC provider. |
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
