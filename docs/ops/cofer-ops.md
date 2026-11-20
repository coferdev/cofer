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

## cofer-ops replay

```bash
cofer-ops replay
```

Rebuilds every record that comes from chain events (members' shares and active flags, the set-aside ledger, the
pending admin changes ledger and the fee ledger) from the stored `chain_events`, into a scratch copy in memory, and
lists every difference from the live tables. It only reads: the live tables are never written. Exit code 0 when there
is no difference, 1 when there is at least one. Run it when the nightly `reconcile-mismatch` alert opens.
