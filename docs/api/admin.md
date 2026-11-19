# GET /v1/admin/pending

Every change the factory owner has queued behind the 48-hour timelock and not yet applied: a new price feed, a swap
adapter, or a new swap fee. Nothing on this list can take effect before its `canApplyAfter` time.

```bash
curl https://<signer site>/v1/admin/pending
```

`pending` (soonest first): `kind`, `change` (what it does, in plain words), `canApplyAfter` (unix time) and
`canApplyAfterUtc`, `secondsLeft`, and the queuing `queuedBlock` and `queuedTx`. `recent`: the last changes that were
applied or replaced by a newer one, with `resolvedBlock` and `resolvedTx`. From the
[pending admin changes ledger](../ledgers.md). It may be cached for 30 seconds.

Check it yourself: the factory's `pendingFeed(asset)`, `pendingAdapterEta(adapter)`, `pendingSwapFeeBps()` and
`pendingSwapFeeEta()`, and its `FeedQueued`, `AdapterQueued` and `SwapFeeQueued` logs. Exits never depend on any of
these.
