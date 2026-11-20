# Metrics

`GET /metrics` on the api role, in the Prometheus text format, for monitoring tools on the server itself. It answers
only a request made on the server (from 127.0.0.1 or ::1, not passed on by the reverse proxy); anyone else gets 404.

```bash
curl -s http://127.0.0.1:<PORT>/metrics
```

| Metric | What |
|---|---|
| `cofer_indexer_lag_seconds`, `cofer_indexer_lag_blocks` | how far the indexer is behind the chain |
| `cofer_queue_jobs{queue,state}` | background jobs waiting, active, delayed or failed, per queue |
| `cofer_alerts_open` | staff alerts open now |
| `cofer_feed_age_seconds{feed}`, `cofer_feed_limit_seconds{feed}` | each price feed's age and its limit |
| `cofer_public_api_requests_total{status}` | public API answers since start, by status |
