/** The App's calls to its server (spec §10.1): POST /arena/api/<procedure>, JSON, bigint as decimal strings. */
export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
  }
}

export async function call<T>(proc: string, input: unknown = {}): Promise<T> {
  const r = await fetch(`/arena/api/${proc}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  const body = (await r.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!r.ok) throw new ApiError(r.status, body.error ?? `Something went wrong (${r.status}).`, body.code);
  return body as T;
}

export interface Me {
  tgId: number;
  address: string | null;
  expires: number;
  practice: boolean;
  chainId: number;
}

export interface PracticeCard {
  id: string;
  table: string;
  startAt: number;
  endAt: number;
  seats: number;
  finished: boolean;
  rank: number | null;
}

export interface BoardRow {
  seat: string;
  name: string;
  rank: number;
  scoreE6: string;
  equity: string;
  out: boolean;
}

export interface Board {
  top: BoardRow[];
  me: BoardRow | null;
  n: number;
  ts: number;
  endAt: number;
}

export interface Position {
  symbol: string;
  product: 'PERP' | 'SPOT';
  qty: string;
  entry: string | null;
  lev: string | null;
  mark: string | null;
  upnl: string | null;
  mm: string | null;
  holdUntil: number | null;
}

export interface OpenOrder {
  ref: string;
  kind: string;
  symbol: string;
  product: string;
  side: string | null;
  limitPx: string | null;
  triggerPx: string | null;
  fired: boolean;
  recvTs: number;
}

export interface SeatState {
  seat: string;
  equity: string;
  free: string;
  mm: string;
  warn: boolean;
  eliminatedAt: number | null;
  positions: Position[];
  orders: OpenOrder[];
}

export interface Result {
  id: string;
  table: string;
  head: string;
  ticks: number;
  events: number;
  standings: { rank: number; seat: string; name: string; finalEquity: string; maxDrawdownBps: string; score1e6: string; activityOk: boolean; eliminatedAt: number | null }[];
  verify: string;
}

export interface PracticeGame {
  id: string;
  table: string;
  seat: string;
  startAt: number;
  endAt: number;
  rulesHash: string;
  rules: { markets: string[]; products: string[]; minHoldSec: number; fillDelayMs: number; feeBps: number };
  leverageCap: Record<string, number>;
  seats: { seat: string; name: string }[];
  board: Board;
  me: SeatState;
  result: Result | null;
}

export interface MarkMsg {
  s: string;
  px: string | null;
  status: string;
  src: [number, number, number];
  ts: number;
}
