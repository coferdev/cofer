# Restore guide

How to bring Cofer back from a backup onto a fresh server, step by step, and let the indexer catch up afterwards.
Nothing here touches the chain: group accounts, balances and exits live on Robinhood Chain and never depend on this
database. The database holds the bot's records (members' keys, votes in progress, the indexer's copy of events).

Backups are made daily by `cofer-ops backup` (see [backup.md](backup.md)): `cofer-YYYY-MM-DD.dump` files in
`/var/backups/cofer`, each already restore-tested.

## 1. Prepare the new server

1. Install Postgres (same major version or newer), Redis, Bun and the Postgres client tools.
2. Create the database user and an empty database (paste one line at a time):

   ```bash
   sudo -u postgres createuser --pwprompt cofer
   sudo -u postgres createdb --owner cofer cofer
   ```

3. Copy the newest good backup to the new server (`last-good.json` in the backup folder names it):

   ```bash
   scp old-server:/var/backups/cofer/cofer-YYYY-MM-DD.dump /tmp/
   ```

## 2. Restore the backup

The connection details go in `PG*` settings, never on the command line:

```bash
export PGHOST=localhost PGUSER=cofer PGDATABASE=cofer
read -rs PGPASSWORD && export PGPASSWORD
pg_restore --no-owner --dbname cofer /tmp/cofer-YYYY-MM-DD.dump
```

Then bring the tables up to the running release's shape (any table added since the backup is created; nothing is
dropped):

```bash
cd /srv/cofer-releases/testnet/current/services
set -a; . /home/cofer/cofer/services/.env; set +a
bunx drizzle-kit migrate
```

## 3. Check the restore

Every table should have rows like the old server (the backup's own restore test compared them when it was made):

```bash
psql -c "select relname, n_live_tup from pg_stat_user_tables order by relname"
psql -c "select name, block from cursors order by name"
```

`cursors` shows where the indexer and each ledger stopped: the moment of the backup.

## 4. Start the services and let them catch up

Start the services as usual (`sudo systemctl start cofer`). The indexer reads the chain from its saved block onwards,
so every event since the backup is read again; events already stored are skipped, never counted twice. The ledgers
follow from their own saved positions the same way.

Watch it catch up:

```bash
curl -s http://127.0.0.1:<PORT>/v1/status
cofer-ops status --units cofer --releases /srv/cofer-releases/testnet
```

`indexer.state` turns `live` once it has caught up. Then run the checks once:

```bash
cofer-ops replay
```

No differences means every record matches the chain events. The nightly reconciliation compares the database with the
chain itself the following night.

## What a restore cannot bring back

- Anything written after the backup that exists only in the database: a vote started in the bot but not yet signed
  by anyone, or a sign-up link sent but not yet used. Members start those again. Everything on the chain is untouched.
- Telegram messages are not in the database; the bot's next messages continue as normal.
