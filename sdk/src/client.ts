/**
 * createCoferClient: typed, read-only access to every public Cofer API call, and two direct chain reads (a group's
 * summary and members) for when you would rather not trust the API. Nothing here can sign or send.
 */
import { createPublicClient, getAddress, http, type PublicClient } from "viem";
import type { AdminPending, Answer, DepositReceipt, ExitReceipt, FeesPage, Holdings, KeyGroups, MembersPage, Ownership, PotSummary, SetAsides, SnapshotProof, SpendReceipt, Status, TimelinePage, TxExplanation, Vote, VoteReceipt, Address, Hash } from "./types";

export class CoferApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CoferApiError";
  }
}

export interface ClientOptions {
  /** The signer site's address, for example https://sign.example (the API is under /v1). */
  baseUrl: string;
  /** A chain RPC for the direct chain reads (default: Robinhood Chain mainnet's public RPC). */
  rpcUrl?: string;
  fetch?: typeof fetch;
  /** Your own chain reader for the direct reads (a viem public client); default: one on rpcUrl. */
  chain?: Pick<PublicClient, "readContract">;
}

const POT_READ_ABI = [
  { type: "function", name: "memberCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "threshold", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "thresholdBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  { type: "function", name: "requiredVotes", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "config", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }, { type: "uint16" }, { type: "uint16" }, { type: "bool" }] },
  { type: "function", name: "totalShares", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "heldAssets", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] },
  { type: "function", name: "members", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] },
  { type: "function", name: "memberInfo", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "tuple", components: [{ name: "active", type: "bool" }, { name: "shares", type: "uint256" }, { name: "allowance", type: "uint128" }, { name: "period", type: "uint32" }, { name: "periodStart", type: "uint64" }, { name: "spent", type: "uint128" }] }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

export function createCoferClient(o: ClientOptions) {
  const f = o.fetch ?? fetch;
  const base = o.baseUrl.replace(/\/$/, "");
  let chain = o.chain;
  const rpc = () => (chain ??= createPublicClient({ transport: http(o.rpcUrl ?? "https://rpc.mainnet.chain.robinhood.com") }) as PublicClient);

  async function get<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    const q = Object.entries(query).filter(([, v]) => v !== undefined && v !== "");
    const url = `${base}/v1${path}${q.length ? `?${q.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&")}` : ""}`;
    const r = await f(url, { headers: { accept: "application/json" } });
    const body = (await r.json().catch(() => null)) as (Answer<T> & { error?: { code: string; message: string } }) | null;
    if (!r.ok || !body || body.error) throw new CoferApiError(r.status, body?.error?.code ?? "unavailable", body?.error?.message ?? `The API answered ${r.status}.`);
    return body.data;
  }

  return {
    status: () => get<Status>("/status"),
    tx: (hash: Hash) => get<TxExplanation>(`/tx/${hash}`),
    ownership: () => get<Ownership>("/proof/ownership"),
    pot: (pot: Address) => get<PotSummary>(`/pots/${pot}`),
    members: (pot: Address, page: { after?: Address; limit?: number } = {}) => get<MembersPage>(`/pots/${pot}/members`, page),
    votes: (pot: Address, q: { state?: Vote["state"]; limit?: number } = {}) => get<{ votes: Vote[] }>(`/pots/${pot}/votes`, q).then((x) => x.votes),
    timeline: (pot: Address, page: { after?: string; limit?: number } = {}) => get<TimelinePage>(`/pots/${pot}/timeline`, page),
    exitReceipt: (tx: Hash) => get<ExitReceipt>(`/receipts/exit/${tx}`),
    depositReceipt: (tx: Hash) => get<DepositReceipt>(`/receipts/deposit/${tx}`),
    spendReceipt: (tx: Hash) => get<SpendReceipt>(`/receipts/spend/${tx}`),
    voteReceipt: (digest: Hash) => get<VoteReceipt>(`/receipts/vote/${digest}`),
    keyGroups: (address: Address) => get<KeyGroups>(`/members/${address}`),
    setAsides: (address: Address) => get<SetAsides>(`/set-asides/${address}`),
    adminPending: () => get<AdminPending>("/admin/pending"),
    holdings: (pot: Address, range: { from?: string; to?: string } = {}) => get<Holdings>(`/pots/${pot}/holdings`, range),
    snapshotProof: (pot: Address, block?: bigint) => get<SnapshotProof>(`/proof/snapshot/${pot}`, { block: block?.toString() }),
    fees: (pot: Address, page: { after?: string; limit?: number } = {}) => get<FeesPage>(`/pots/${pot}/fees`, page),

    /** A group's summary read straight from the chain (no API): member count, vote rule, settings, tokens and balances. */
    async potFromChain(pot: Address) {
      const c = rpc();
      const a = getAddress(pot);
      const r = <T>(functionName: string, args: readonly unknown[] = []) => c.readContract({ address: a, abi: POT_READ_ABI, functionName: functionName as never, args: args as never }) as Promise<T>;
      const [memberCount, threshold, thresholdBps, required, config, totalShares, held] = await Promise.all([r<bigint>("memberCount"), r<number>("threshold"), r<number>("thresholdBps"), r<bigint>("requiredVotes"), r<readonly [number, number, number, boolean]>("config"), r<bigint>("totalShares"), r<readonly Address[]>("heldAssets")]);
      const assets = await Promise.all(held.map(async (t) => ({ asset: getAddress(t), rawBalance: ((await c.readContract({ address: t, abi: POT_READ_ABI, functionName: "balanceOf", args: [a] })) as bigint).toString() })));
      return { address: a, memberCount: Number(memberCount), voteRule: { threshold, thresholdBps, approvalsNeeded: Number(required) }, exitWindowSeconds: config[0], maxSlipBps: config[1], entrySpreadBps: config[2], depositsOpen: config[3], totalShares: totalShares.toString(), assets };
    },

    /** A group's members read straight from the chain: each address with active flag and shares. */
    async membersFromChain(pot: Address) {
      const c = rpc();
      const a = getAddress(pot);
      const list = (await c.readContract({ address: a, abi: POT_READ_ABI, functionName: "members" })) as readonly Address[];
      return Promise.all(
        list.map(async (m) => {
          const i = (await c.readContract({ address: a, abi: POT_READ_ABI, functionName: "memberInfo", args: [m] })) as { active: boolean; shares: bigint };
          return { address: getAddress(m), active: i.active, shares: i.shares.toString() };
        }),
      );
    },
  };
}

export type CoferClient = ReturnType<typeof createCoferClient>;
