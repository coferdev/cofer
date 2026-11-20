# Daily database backup

`cofer-ops backup` makes the day's backup and proves it can be restored:

1. `pg_dump` of the whole database (custom format) into a private folder (mode 700; each file mode 600), one file per
   UTC day: `cofer-YYYY-MM-DD.dump`.
2. It restores that file into a throwaway database and compares every table's row count with the live one, then
   drops the throwaway database.
3. It removes backups older than 14 days (only `cofer-*.dump` files).
4. On success it records the backup in `last-good.json` (`cofer-ops status --backups <dir>` shows it). On any
   failure the staff alert `backup-failed` opens; the next good backup clears it.

The connection details reach the Postgres tools as `PG*` environment variables, never on a command line, and are
never printed. It needs the Postgres client tools (`pg_dump`, `pg_restore`, `createdb`, `dropdb`) on the server, and
the database user must be allowed to create a database (for the throwaway copy).

## Run it every day (systemd timer, set up once)

`/etc/systemd/system/cofer-backup.service`:

```ini
[Unit]
Description=Cofer daily database backup (restore-tested)

[Service]
Type=oneshot
User=cofer
EnvironmentFile=/home/cofer/cofer/services/.env
WorkingDirectory=/srv/cofer-releases/testnet/current/services
ExecStart=/home/cofer/.bun/bin/bun scripts/ops/backup.ts --dir /var/backups/cofer
```

`/etc/systemd/system/cofer-backup.timer`:

```ini
[Unit]
Description=Cofer daily database backup

[Timer]
OnCalendar=*-*-* 03:30:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
```

Then: `sudo systemctl daemon-reload && sudo systemctl enable --now cofer-backup.timer`. Check it with
`systemctl list-timers cofer-backup.timer` and `cofer-ops status --backups /var/backups/cofer`.
