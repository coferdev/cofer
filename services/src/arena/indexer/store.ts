/**
 * Applies one ArenaStep to the arena_* tables, inside the caller's transaction. Every write is an upsert or a
 * guarded update, so a step applied twice leaves the same rows (the loop also records each log once).
 */
import type postgres from "postgres";
import type { ArenaStep } from "./arenaEvents";

/** What TableCreated alone does not carry: read from the new table's params() in the same block range. */
export interface TableParamsView {
  token: string;
  buyIn: bigint;
  prize: bigint;
  minSeats: number;
  maxSeats: number;
  lockAt: number; // s, 0 = sit-and-go
  openUntil: number; // s
  duration: number; // s
}

export interface StepContext {
  at: Date; // block time
  block: bigint;
  txHash: string;
  params?: TableParamsView; // table-created only
}

type Tx = postgres.TransactionSql;
const ts = (s: number) => (s ? new Date(s * 1000) : null);
const lc = (a: string) => a.toLowerCase();

export async function applyStep(tx: Tx, s: ArenaStep, c: StepContext): Promise<void> {
  switch (s.op) {
    case "table-created": {
      const p = c.params;
      if (!p) throw new Error(`table-created ${s.table} without its params`);
      await tx`
        INSERT INTO arena_tables (address, mode, host_address, rules_hash, buy_in, prize, prize_token, min_seats, max_seats,
          lock_at, open_until, duration_s, signer_set_id, state, created_block, created_at)
        VALUES (${s.table}, ${s.mode}, ${s.host}, ${s.rulesHash}, ${p.buyIn.toString()}, ${p.prize.toString()}, ${p.token},
          ${p.minSeats}, ${p.maxSeats}, ${ts(p.lockAt)}, ${ts(p.openUntil)}, ${p.duration}, ${s.signerSetId}, 'open',
          ${c.block.toString()}, ${c.at})
        ON CONFLICT (address) DO NOTHING`;
      return;
    }
    case "joined":
      await tx`
        INSERT INTO arena_seats (table_address, seat, address, session_key_hash, prize_eligible, joined_at)
        VALUES (${s.table}, ${s.seat}, ${s.player}, ${s.sessionKeyHash}, ${s.prizeEligible}, ${c.at})
        ON CONFLICT (table_address, address) DO UPDATE SET seat = EXCLUDED.seat, session_key_hash = EXCLUDED.session_key_hash,
          session_pubkey = NULL, prize_eligible = EXCLUDED.prize_eligible, joined_at = EXCLUDED.joined_at, left_at = NULL`;
      return;
    case "left": {
      // the escrow moves its last seat into the leaver's place (swap and pop): do the same here
      const [me] = await tx`SELECT seat FROM arena_seats WHERE table_address = ${s.table} AND lower(address) = ${lc(s.player)} AND left_at IS NULL`;
      if (!me) return;
      await tx`UPDATE arena_seats SET left_at = ${c.at} WHERE table_address = ${s.table} AND lower(address) = ${lc(s.player)}`;
      const [last] = await tx`SELECT address, seat FROM arena_seats WHERE table_address = ${s.table} AND left_at IS NULL ORDER BY seat DESC LIMIT 1`;
      if (last && last.seat > me.seat) await tx`UPDATE arena_seats SET seat = ${me.seat} WHERE table_address = ${s.table} AND address = ${last.address}`;
      return;
    }
    case "locked":
      await tx`UPDATE arena_tables SET state = 'locked', locked_at = ${ts(s.lockedAt)}, end_at = ${ts(s.endAt)},
        hard_deadline = ${ts(s.hardDeadline)}, pot = ${s.pot.toString()} WHERE address = ${s.table} AND state = 'open'`;
      return;
    case "result-posted":
      await tx`UPDATE arena_tables SET state = 'settling', round = ${s.round}, dispute_end = ${ts(s.disputeEnd)}
        WHERE address = ${s.table} AND state IN ('locked', 'settling', 'disputed')`;
      await tx`INSERT INTO arena_results (table_address, round, digest, posted_tx, posted_at, dispute_end)
        VALUES (${s.table}, ${s.round}, ${s.digest}, ${c.txHash}, ${c.at}, ${ts(s.disputeEnd)})
        ON CONFLICT (table_address, round) DO UPDATE SET digest = EXCLUDED.digest, posted_tx = EXCLUDED.posted_tx,
          posted_at = EXCLUDED.posted_at, dispute_end = EXCLUDED.dispute_end`;
      return;
    case "disputed":
      await tx`UPDATE arena_tables SET state = 'disputed' WHERE address = ${s.table} AND state = 'settling'`;
      await tx`INSERT INTO arena_disputes (table_address, by_address, round, reason_hash, bond, tx_hash, created_at)
        VALUES (${s.table}, ${s.by}, ${s.round}, ${s.reasonHash}, ${s.bond.toString()}, ${c.txHash}, ${c.at})
        ON CONFLICT DO NOTHING`;
      return;
    case "objection":
      return; // recorded in arena_chain_events; a Freeroll objection changes no state
    case "settled":
      await tx`UPDATE arena_tables SET state = 'settled' WHERE address = ${s.table} AND state <> 'refunded'`;
      return;
    case "refunded":
    case "cancelled":
      await tx`UPDATE arena_tables SET state = 'refunded' WHERE address = ${s.table} AND state <> 'settled'`;
      return;
    case "claimed":
      await tx`INSERT INTO arena_claims (table_address, account, amount, to_address, tx_hash, claimed_at)
        VALUES (${s.table}, ${s.account}, ${s.amount.toString()}, ${s.to}, ${c.txHash}, ${c.at})
        ON CONFLICT (table_address, account) DO NOTHING`;
      return;
    case "result-recorded":
      await tx`INSERT INTO arena_results (table_address, round, digest, log_head, events_root, standings_root, log_uri)
        VALUES (${s.table}, ${s.round}, ${s.digest}, ${s.logHead}, ${s.eventsRoot}, ${s.standingsRoot}, ${s.logURI})
        ON CONFLICT (table_address, round) DO UPDATE SET digest = EXCLUDED.digest, log_head = EXCLUDED.log_head,
          events_root = EXCLUDED.events_root, standings_root = EXCLUDED.standings_root, log_uri = EXCLUDED.log_uri`;
      return;
    case "tape-anchored":
      await tx`INSERT INTO arena_tape_anchors (hour_id, tape_head, uri, tx_hash, anchored_at)
        VALUES (${s.hourId.toString()}, ${Buffer.from(s.tapeHead.slice(2), "hex")}, ${s.uri}, ${c.txHash}, ${c.at})
        ON CONFLICT (hour_id) DO NOTHING`;
      return;
    case "funded":
      return; // the prize is read from the table's params at creation; the vault spend is in arena_chain_events
    case "staked":
      await tx`INSERT INTO stake_positions (id, owner, amount, term, unlock_at)
        VALUES (${s.id.toString()}, ${s.owner}, ${s.amount.toString()}, ${s.term}, ${ts(s.unlockAt)})
        ON CONFLICT (id) DO NOTHING`;
      return;
    case "unstaked":
      await tx`UPDATE stake_positions SET closed = true WHERE id = ${s.id.toString()}`;
      return;
    case "pledged":
      await tx`UPDATE stake_positions SET pledged = pledged + ${s.amount.toString()}, amount = amount - ${s.amount.toString()} WHERE id = ${s.id.toString()}`;
      return;
    case "bond-marked":
      await tx`UPDATE stake_positions SET is_bond = true WHERE id = ${s.id.toString()}`;
      return;
    case "bond-extended":
      await tx`UPDATE stake_positions SET bond_until = ${ts(s.bondUntil)} WHERE lower(owner) = ${lc(s.owner)} AND is_bond AND NOT closed`;
      return;
    case "admin":
      return; // recorded in arena_chain_events; the role checks read the chain
  }
}
