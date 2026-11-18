/**
 * Notices from the release system (cofer-ship). The release system does the work (gate, build,
 * tests, testnet then mainnet, live checks, rollback, public push, GitHub release) and never posts
 * updates itself: it writes one notice file per event into TEAMBOT_DATA_DIR/inbox, and the team bot
 * is the only one that posts. Each notice has a unique id; the team bot remembers the ids it has
 * handled, so a notice delivered twice posts once.
 */
import type { StatusKind } from "./state";

export interface AlarmNotice {
  name: string; // e.g. "release-tests-failed"
  what: string; // what is wrong, one or two plain sentences
  who: string; // what to do
  n?: number; // the update
  postAt?: string; // its posting time (ISO)
}

export type Notice =
  | { id: string; kind: "notice"; type: "armed"; at: string; changed?: boolean }
  | { id: string; kind: "notice"; type: "disarmed" }
  | { id: string; kind: "notice"; type: "paused"; reason: string }
  | { id: string; kind: "notice"; type: "resumed"; overdue: number }
  | { id: string; kind: "notice"; type: "preflight"; bad: [number, string[]][]; total: number }
  | { id: string; kind: "notice"; type: StatusKind; n: number; what: string; next: string; link?: string }
  | { id: string; kind: "notice"; type: "test"; n: number; what: string; next: string; link?: string }
  | { id: string; kind: "notice"; type: "alarm"; alarm: AlarmNotice }
  | { id: string; kind: "notice"; type: "cleared"; name: string; reason: string };

const str = (x: unknown) => typeof x === "string";
const num = (x: unknown) => typeof x === "number" && Number.isInteger(x) && x > 0;

/** The notice in a parsed inbox file, or null if it is not a well-formed notice. */
export function asNotice(j: unknown): Notice | null {
  if (!j || typeof j !== "object") return null;
  const o = j as Record<string, unknown>;
  if (o.kind !== "notice" || !str(o.id) || !/^[\w.-]{1,80}$/.test(o.id as string)) return null;
  switch (o.type) {
    case "armed":
      return str(o.at) && !Number.isNaN(Date.parse(o.at as string)) ? (o as unknown as Notice) : null;
    case "disarmed":
      return o as unknown as Notice;
    case "paused":
      return str(o.reason) ? (o as unknown as Notice) : null;
    case "resumed":
      return typeof o.overdue === "number" ? (o as unknown as Notice) : null;
    case "preflight":
      return Array.isArray(o.bad) && num(o.total) ? (o as unknown as Notice) : null;
    case "released":
    case "delayed":
    case "held":
    case "rolled_back":
    case "test":
      return num(o.n) && str(o.what) && str(o.next) ? (o as unknown as Notice) : null;
    case "alarm": {
      const a = o.alarm as Record<string, unknown> | undefined;
      return a && str(a.name) && /^[a-z0-9-]{1,60}$/.test(a.name as string) && str(a.what) && str(a.who) ? (o as unknown as Notice) : null;
    }
    case "cleared":
      return str(o.name) && str(o.reason) ? (o as unknown as Notice) : null;
    default:
      return null;
  }
}

/** Heartbeat files: each side writes its own every tick; "missing" means older than this. */
export const HEARTBEAT_STALE_MS = 2 * 60_000;
