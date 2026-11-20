# cofer-ops

Server commands for the people who run Cofer. On the server, `cofer-ops` is a shortcut for
`bun <current release>/services/scripts/ops/cofer-ops.ts`, run as the service user with the service's settings
loaded.

## cofer-ops status

```bash
cofer-ops status --units cofer,cofer-mainnet --releases /srv/cofer-releases/testnet
```

One screen: each role's systemd unit (active or not), the release folder in use and when it was deployed, indexer
lag, background queue sizes, open staff alerts, and which settings are set. It never prints a secret: settings are
listed by name only, as set or not set.
