/**
 * A Practice game (spec §4.12): no chain, no money. Seats are players' accounts (or practice bots), each with a
 * per-game P-256 session key; orders are signed and checked exactly as at a real table; the game runs on the live
 * tape's ticks, and the finished log replays from public data alone (arena-replay verify-practice).
 * Its table id is a stand-in address derived from the game id, so orders still name the one game they belong to.
 */
import { type Hex, getAddress, keccak256, slice, toHex } from "viem";
import { GameHost, type SeatEvent } from "../engine/host";
import { type RulesJson, canonical, parseRules, rulesHash } from "../engine/rules";
import type { Open } from "../log/record";
import type { Mark } from "../marks/median";
import { HOUR_MS, hourOf } from "../marks/tape";
import type { Standing } from "../scoring/score";

export const PRACTICE_MIN_MS = 15 * 60_000; // spec: 15 min – 7 d
export const PRACTICE_MAX_MS = 7 * 86_400_000;

export function practiceRules(engine: string): RulesJson {
  return {
    v: 1, mode: "PRACTICE", markets: ["BTC", "ETH", "NVDA", "TSLA", "SPY"], products: ["SPOT", "PERP", "OPTION"],
    leverageCap: { crypto: 20, stock: 10 }, stack: "10000000000", fillDelayMs: 1000, minHoldSec: 60, feeBps: 5, funding: "none",
    lambda: "0.5", activity: { minFills: 1, minExposure: "0.2" },
    options: { premiumBudget: "0.5", spread: "0.03", sigma: { BTC: "0.52", ETH: "0.68", NVDA: "0.45", TSLA: "0.6", SPY: "0.2" }, expiries: ["end"] },
    marks: { sources: ["lighter", "arcus", "chainlink"], maxDivergence: "0.01", jumpGuard: "0.05" },
    collusion: { O: "0.6", rho: "-0.8", sync: 2 }, engine,
  };
}

/** The stand-in table address of a Practice game: the last 20 bytes of keccak256("cofer practice <id>"). */
export const practiceTable = (id: string): Hex => getAddress(slice(keccak256(toHex(`cofer practice ${id}`)), 12));

export interface PracticeSeat {
  address: Hex; // the player's account (or a bot's stand-in address)
  pubkey: Hex; // 65-byte uncompressed P-256 session key
}

export interface PracticeOpts {
  chainId: number;
  id: string;
  rules: RulesJson;
  seats: PracticeSeat[];
  startAt: number; // ms, on a whole second
  durationMs: number;
  now?: () => number; // the engine's receive clock (default: wall clock)
  /** Tests only: allow a game shorter than the 15-minute Practice minimum. */
  allowShort?: boolean;
}

export interface PracticeResult {
  table: Hex;
  head: Hex;
  standings: Standing[];
  log: Hex[];
  open: Open;
}

export class PracticeGame {
  readonly open: Open;
  readonly host: GameHost;
  private done: PracticeResult | null = null;
  ticks = 0;

  constructor(readonly o: PracticeOpts) {
    if (o.rules.mode !== "PRACTICE") throw new Error("not Practice rules");
    if (!o.allowShort && (o.durationMs < PRACTICE_MIN_MS || o.durationMs > PRACTICE_MAX_MS)) throw new Error("Practice runs 15 minutes to 7 days");
    if (o.startAt % 1000 !== 0) throw new Error("a game starts on a whole second");
    if (o.seats.length < 1 || o.seats.length > 1000) throw new Error("Practice takes 1 to 1,000 seats");
    const endAt = o.startAt + o.durationMs;
    const hours: number[] = [];
    for (let h = hourOf(o.startAt); h <= hourOf(endAt - 1); h++) hours.push(h);
    this.open = {
      chainId: o.chainId, table: practiceTable(o.id), rulesHash: rulesHash(o.rules), rulesJson: canonical(o.rules),
      seats: o.seats.map((s) => s.address), pubkeys: o.seats.map((s) => s.pubkey),
      lockedAt: o.startAt, endAt, lockBlock: 0n, tapeHours: hours,
    };
    const r = parseRules(o.rules);
    this.host = new GameHost(this.open, r, { stack: r.stack, lambdaBps: r.lambdaBps, minFills: r.minFills, minExposureBps: r.minExposureBps }, o.now ?? Date.now);
  }

  get finished() {
    return this.done !== null;
  }

  /** One tape tick. Ticks before the start are ignored; the first tick at or after the end closes the game. */
  tick(ts: number, marks: Map<string, Mark>): SeatEvent[] {
    if (this.done || ts < this.open.lockedAt) return [];
    if (ts >= this.open.endAt) {
      this.close();
      return [];
    }
    this.ticks++;
    return this.host.tick(ts, marks);
  }

  place(bytes: Hex, sig: Hex) {
    return this.host.place(bytes, sig);
  }

  close(): PracticeResult {
    if (this.done) return this.done;
    const { standings, head } = this.host.close();
    this.done = { table: this.open.table, head, standings, log: [...this.host.rec.log], open: this.open };
    return this.done;
  }
}

export { HOUR_MS };
