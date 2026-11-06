/**
 * The dashboard's only connection to the services: three read-only calls on its own address
 * (config.apiBase). Every amount arrives as a decimal string of raw units with its decimals and is
 * kept that way (see money.ts). Errors become one of a few kinds the page knows how to show.
 */

export type ApiErrorKind = 'signed-out' | 'not-found' | 'down' | 'offline' | 'bad-response';

export class ApiError extends Error {
  constructor(public kind: ApiErrorKind, message: string) {
    super(message);
  }
}

export interface PotSummary {
  address: string;
  title: string;
  members: number;
  totalUsdg: string | null;
  partial: boolean;
}

export interface PotsResponse {
  chainId: number;
  linked: boolean;
  address?: string;
  pots: PotSummary[];
}

export interface Holding {
  asset: string;
  symbol: string;
  decimals: number;
  isStock: boolean;
  available: string;
  shownQuantity: string;
  valueUsdg: string | null;
  unitPriceUsdg: string | null;
  pricePaused: boolean;
  balanceAsOf: string;
}

export interface Member {
  address: string;
  you: boolean;
  username: string | null;
  shares: string;
  shareBps: number;
  allowance: string;
  period: number;
}

export type ProposalState = 'pending' | 'confirmed' | 'failed';

export interface Proposal {
  id: string;
  kind: number;
  summary: string;
  status: string;
  state: ProposalState;
  stateText: string;
  approvals: number;
  required: number;
  signedByYou: boolean;
  executeAfter: string | null;
  txHash: string | null;
  createdAt: string;
}

export interface ActivityItem {
  id: string;
  type: string;
  at: string;
  block: string;
  txHash: string;
  member?: string | null;
  to?: string | null;
  asset?: string | null;
  assetIn?: string | null;
  assetOut?: string | null;
  amount?: string | null;
  amountIn?: string | null;
  amountOut?: string | null;
  months?: string | null;
}

export interface PotView {
  address: string;
  title: string;
  chainId: number;
  usdg: { address: string; symbol: string; decimals: number };
  value: { totalUsdg: string | null; partial: boolean };
  you: {
    address: string;
    shares: string;
    shareBps: number;
    valueUsdg: string | null;
    allowance: string;
    allowanceLeft: string | null;
    period: number;
    nextResetAt: string | null;
  };
  members: Member[];
  rules: {
    membersCount: number;
    approvalsRequired: number | null;
    threshold: number;
    thresholdBps: number;
    exitWindowSec: number;
    depositsOpen: boolean;
    planPaidUntil: string | null;
  };
  holdings: Holding[];
  proposals: Proposal[];
  activity: ActivityItem[];
  assets: Record<string, { symbol: string; decimals: number }>;
  indexer: { block: string | null; behind: boolean };
  asOf: string;
}

const TEXT: Record<ApiErrorKind, string> = {
  'signed-out': 'Your dashboard session has ended. Open it again from Telegram: send /me to the bot.',
  'not-found': 'This group account was not found, or you are not a member of it.',
  down: "Couldn't load the data just now. Retrying.",
  offline: "Couldn't reach the server. Retrying.",
  'bad-response': 'The server sent something unexpected. Retrying.',
};

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export function apiClient(base: string, fetchFn: Fetch = (i, o) => fetch(i, o)) {
  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    let r: Response;
    try {
      r = await fetchFn(`${base}${path}`, { ...init, cache: 'no-store', credentials: 'omit' });
    } catch {
      throw new ApiError('offline', TEXT.offline);
    }
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      body = null;
    }
    const serverText = typeof (body as { error?: unknown })?.error === 'string' ? ((body as { error: string }).error) : null;
    if (r.status === 401) throw new ApiError('signed-out', serverText ?? TEXT['signed-out']);
    if (r.status === 404) throw new ApiError('not-found', TEXT['not-found']);
    if (!r.ok) throw new ApiError('down', TEXT.down);
    if (body === null || typeof body !== 'object') throw new ApiError('bad-response', TEXT['bad-response']);
    return body as T;
  }
  const auth = (session: string) => ({ headers: { authorization: `Bearer ${session}` } });
  return {
    exchange: (token: string) =>
      call<{ session: string; expiresAt: string }>('/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) }),
    pots: (session: string) => call<PotsResponse>('/pots', auth(session)),
    pot: (session: string, address: string) => {
      if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return Promise.reject(new ApiError('not-found', TEXT['not-found']));
      return call<PotView>(`/pots/${address}`, auth(session));
    },
  };
}

export type ApiClient = ReturnType<typeof apiClient>;
