-- Arena tables (spec §9). Applied by src/arena/db/migrate.ts, recorded in arena_migrations; separate from the
-- group-account migrations in drizzle/, which never read or write any arena_* table.
CREATE TYPE arena_mode  AS ENUM ('FRIEND','FREEROLL','PRACTICE');
CREATE TYPE arena_state AS ENUM ('open','locked','settling','disputed','settled','refunded','practice_live','practice_done');

CREATE TABLE arena_tables (
  address          text PRIMARY KEY,                 -- checksummed; 'practice:<uuid>' for Practice
  mode             arena_mode NOT NULL,
  host_tg          bigint, host_address text,
  chat_id          bigint,                           -- group binding (nullable)
  rules_hash       text NOT NULL, rules_json jsonb,  -- the JSON is stored by the API at create; the chain has the hash
  buy_in           numeric(78,0) NOT NULL DEFAULT 0, prize numeric(78,0) NOT NULL DEFAULT 0, prize_token text,
  min_seats        smallint NOT NULL, max_seats smallint NOT NULL,
  lock_at          timestamptz, open_until timestamptz, duration_s integer,
  locked_at        timestamptz, end_at timestamptz,
  hard_deadline    timestamptz, dispute_end timestamptz,
  signer_set_id    integer, state arena_state NOT NULL, created_block bigint,
  round            smallint, pot numeric(78,0),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON arena_tables (state, lock_at);
CREATE INDEX ON arena_tables (chat_id) WHERE chat_id IS NOT NULL;

CREATE TABLE arena_seats (
  table_address    text REFERENCES arena_tables(address),
  seat             smallint NOT NULL,
  address          text NOT NULL, tg_id bigint,
  session_key_hash text, session_pubkey bytea,
  prize_eligible   boolean NOT NULL DEFAULT false,
  joined_at        timestamptz NOT NULL, left_at timestamptz,
  PRIMARY KEY (table_address, address)
);
-- a seat number is reused after a leave (the escrow compacts its seat list), so it is unique among seated players only
CREATE UNIQUE INDEX arena_seats_live_seat ON arena_seats (table_address, seat) WHERE left_at IS NULL;

CREATE TABLE arena_events (
  table_address    text NOT NULL,
  seq              bigint NOT NULL,
  type             smallint NOT NULL,
  encoded          bytea NOT NULL,
  event_hash       bytea NOT NULL, chain_hash bytea NOT NULL,
  fence            bigint NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (table_address, seq)
);

CREATE TABLE arena_tape (
  hour_id          bigint NOT NULL, seq bigint NOT NULL,
  kind             smallint NOT NULL,
  encoded          bytea NOT NULL, event_hash bytea NOT NULL, chain_hash bytea NOT NULL,
  PRIMARY KEY (hour_id, seq)
);
CREATE TABLE arena_tape_anchors (hour_id bigint PRIMARY KEY, tape_head bytea NOT NULL, uri text, tx_hash text, anchored_at timestamptz);

CREATE TABLE arena_orders (
  table_address text, seat_address text, nonce numeric(78,0), client_id text,
  kind text, body jsonb NOT NULL, sig bytea NOT NULL, recv_ts timestamptz NOT NULL,
  status text NOT NULL, reason text, seq bigint,
  PRIMARY KEY (table_address, seat_address, nonce)
);
CREATE TABLE arena_fills (
  table_address text, seq bigint, seat_address text, symbol text, product text,
  side text, qty numeric(78,0), px numeric(78,0), fee numeric(78,0), tick_ts timestamptz,
  PRIMARY KEY (table_address, seq)
);
CREATE TABLE arena_standings (
  table_address text, seat_address text, final boolean NOT NULL,
  rank smallint, equity numeric(78,0), max_dd_bps integer, score_e6 bigint,
  active boolean, eliminated_at timestamptz, flags text[],
  payout numeric(78,0), snapshot_at timestamptz NOT NULL,
  PRIMARY KEY (table_address, seat_address, final)
);
CREATE TABLE arena_results (
  table_address text, round smallint, digest text, log_head text, events_root text,
  standings_root text, podium text[], payout_root text, total_payout numeric(78,0),
  engine_build text, log_uri text, signatures jsonb, posted_tx text, posted_at timestamptz,
  dispute_end timestamptz,
  PRIMARY KEY (table_address, round)
);
CREATE TABLE arena_disputes (
  table_address text, by_address text, round smallint, reason_hash text, reason_text text,
  bond numeric(78,0), tx_hash text, created_at timestamptz,
  PRIMARY KEY (table_address, by_address, round)
);
CREATE TABLE arena_flags (
  table_address text, kind text, seats text[], metrics jsonb, created_at timestamptz,
  PRIMARY KEY (table_address, kind, seats)
);
CREATE TABLE arena_clusters (cluster_id text, account text, evidence_hash text, reason text, created_at timestamptz,
  PRIMARY KEY (cluster_id, account));
CREATE TABLE arena_claims (table_address text, account text, amount numeric(78,0), to_address text, tx_hash text, claimed_at timestamptz,
  PRIMARY KEY (table_address, account));
CREATE TABLE seasons (id serial PRIMARY KEY, scope text NOT NULL, chat_id bigint, starts_at timestamptz, ends_at timestamptz);
CREATE TABLE season_points (season_id int REFERENCES seasons(id), account text, points integer NOT NULL DEFAULT 0,
  games integer NOT NULL DEFAULT 0, PRIMARY KEY (season_id, account));
CREATE TABLE stake_positions (id numeric(78,0) PRIMARY KEY, owner text, amount numeric(78,0), term smallint,
  unlock_at timestamptz, is_bond boolean DEFAULT false, bond_until timestamptz, pledged numeric(78,0) DEFAULT 0, closed boolean DEFAULT false);
CREATE TABLE geo_checks (id bigserial PRIMARY KEY, tg_id bigint, account text, declared text, ip_country text,
  asn integer, asn_class text, decision text, mode arena_mode, table_address text, created_at timestamptz DEFAULT now());

-- the arena indexer's own position and its once-only record of each log (the group indexer's tables are not used)
CREATE TABLE arena_cursors (name text PRIMARY KEY, block bigint NOT NULL);
CREATE TABLE arena_chain_events (
  tx_hash text NOT NULL, log_index integer NOT NULL, block bigint NOT NULL,
  address text NOT NULL, name text NOT NULL, args jsonb NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
