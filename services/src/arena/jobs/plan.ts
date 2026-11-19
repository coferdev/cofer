/**
 * The Arena's timed jobs (spec §5.3), as pure decisions: what to schedule for a table, and what each job does when it
 * runs against the table's state read from chain at that moment. The worker only reads state, asks here, and
 * relays the one call named (or nothing). Job IDs are fixed per table and time, so adding a job twice is ignored.
 * Each call mirrors the escrow's own checks, so a call that would revert is never sent.
 * Anyone can make these calls; refundAll in particular needs no Cofer service at all (spec §3.4).
 */
export const LOCK_WINDOW_S = 3600; // TableEscrow.LOCK_WINDOW

export const STATE = ["Open", "Locked", "Settling", "Disputed", "Settled", "Refunded"] as const;
export type TableState = (typeof STATE)[number];

export interface TableView {
  table: string;
  state: TableState;
  lockAt: number; // s; 0 = sit-and-go
  openUntil: number; // s
  seats: number;
  minSeats: number;
  endAt: number; // s (after lock)
  disputeEnd: number; // s (after a post)
  hardDeadline: number; // s (after lock)
  round: number; // result round posted (Settling / Disputed)
}

export type JobName = "lock" | "close" | "finalize" | "deadline" | "claim-nudge";
export interface PlannedJob {
  name: JobName;
  jobId: string;
  at: number; // s
}

export const jobId = (name: JobName, table: string, at: number) => `${name}:${table.toLowerCase()}:${at}`;

const job = (name: JobName, table: string, at: number): PlannedJob => ({ name, jobId: jobId(name, table, at), at });

/** What should be scheduled for a table in its current state (the sweep calls this for every live table). */
export function planTable(t: TableView): PlannedJob[] {
  switch (t.state) {
    case "Open":
      return t.lockAt ? [job("lock", t.table, t.lockAt)] : [job("lock", t.table, t.openUntil)];
    case "Locked":
      return [job("close", t.table, t.endAt), job("deadline", t.table, t.hardDeadline)];
    case "Settling":
      return [job("finalize", t.table, t.disputeEnd), job("deadline", t.table, t.hardDeadline)];
    case "Disputed":
      return [job("deadline", t.table, t.hardDeadline)];
    case "Settled":
      return [3600, 86_400, 7 * 86_400].map((d) => job("claim-nudge", t.table, t.disputeEnd + d));
    case "Refunded":
      return [];
  }
}

export type Action =
  | { call: "lock" | "cancel" | "finalize" | "refundAll" }
  | { call: "close-game" } // the engine closes the game, publishes the log and asks the signers
  | { call: "nudge" }
  | { call: null; why: string };

/** What a job does now, given the state read from chain at `now` (s). */
export function decide(name: JobName, t: TableView, now: number): Action {
  switch (name) {
    case "lock": {
      if (t.state !== "Open") return { call: null, why: `already ${t.state}` };
      if (t.lockAt === 0) return now >= t.openUntil ? { call: "cancel" } : { call: null, why: "sit-and-go still open" };
      if (now < t.lockAt) return { call: null, why: "too early" };
      if (now >= t.lockAt + LOCK_WINDOW_S) return { call: "cancel" };
      return t.seats >= t.minSeats ? { call: "lock" } : { call: "cancel" };
    }
    case "close":
      if (t.state !== "Locked") return { call: null, why: `already ${t.state}` };
      return now >= t.endAt ? { call: "close-game" } : { call: null, why: "game still running" };
    case "finalize":
      if (t.state !== "Settling") return { call: null, why: `${t.state}, not Settling` };
      return now >= t.disputeEnd ? { call: "finalize" } : { call: null, why: "dispute window open" };
    case "deadline":
      if (t.state === "Settling") return { call: null, why: "a result is posted: finalize, not refund" };
      if (t.state !== "Locked" && t.state !== "Disputed") return { call: null, why: `already ${t.state}` };
      return now >= t.hardDeadline ? { call: "refundAll" } : { call: null, why: "before the deadline" };
    case "claim-nudge":
      return t.state === "Settled" ? { call: "nudge" } : { call: null, why: `${t.state}` };
  }
}
