/**
 * Chainlink source (spec §4.2): latestRoundData over Multicall3 each second for the FEEDS in chain/addresses.ts.
 * Stock feeds price the Stock Token, so the price is divided by the token's uiMultiplier (read hourly) to get the
 * share price that Lighter and Arcus quote. If the multiplier changes without a matching price change (a corporate
 * action), Chainlink is left out for that symbol until the next session.
 */
import { getAddress, type Address, type PublicClient } from "viem";
import { FEEDS, CONTRACTS_4663_MULTICALL } from "./chainlinkFeeds";
import { multiplierContinuityOk } from "../../core/valuation";
import { nextSessionOpen } from "./calendar";
import { MARKETS, type Symbol } from "./markets";
import { FLAG_CORP_ACTION, type Quote } from "./median";
import type { SourceHandle } from "./lighter";

const WAD = 10n ** 18n;

export const aggregatorAbi = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  {
    type: "function", name: "latestRoundData", stateMutability: "view", inputs: [],
    outputs: [
      { type: "uint80", name: "roundId" }, { type: "int256", name: "answer" }, { type: "uint256", name: "startedAt" },
      { type: "uint256", name: "updatedAt" }, { type: "uint80", name: "answeredInRound" },
    ],
  },
] as const;
export const uiMultiplierAbi = [
  { type: "function", name: "uiMultiplier", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

/** Feed answer -> normalised share price at 1e8, rounded down. multiplier is 1e18 (1e18 for crypto). */
export function normaliseRound(answer: bigint, decimals: number, multiplier: bigint): bigint | null {
  if (answer <= 0n || multiplier <= 0n) return null;
  const px1e8 = decimals >= 8 ? answer / 10n ** BigInt(decimals - 8) : answer * 10n ** BigInt(8 - decimals);
  return (px1e8 * WAD) / multiplier;
}

/** Tracks the multiplier per stock and the corporate-action exclusion window. Pure except for the inputs. */
export class MultiplierGuard {
  private mult = new Map<Symbol, bigint>();
  private lastAnswer = new Map<Symbol, bigint>();
  private excludedUntil = new Map<Symbol, number>();

  multiplier(sym: Symbol): bigint {
    return MARKETS[sym].cls === "stock" ? (this.mult.get(sym) ?? 0n) : WAD;
  }

  /** Record a fresh answer (call on every round read). */
  noteAnswer(sym: Symbol, answer: bigint) {
    this.lastAnswer.set(sym, answer);
  }

  /** Record an hourly multiplier read. Returns true if Chainlink is now excluded for the symbol. */
  noteMultiplier(sym: Symbol, newMult: bigint, newAnswer: bigint, nowMs: number): boolean {
    const prev = this.mult.get(sym);
    const prevAnswer = this.lastAnswer.get(sym);
    this.mult.set(sym, newMult);
    if (prev !== undefined && prev !== newMult && prevAnswer !== undefined) {
      const ok = multiplierContinuityOk({ prevAnswer, newAnswer, prevMultiplier: prev, newMultiplier: newMult });
      if (!ok) {
        this.excludedUntil.set(sym, nextSessionOpen(nowMs) ?? nowMs + 86_400_000);
        return true;
      }
    }
    return false;
  }

  excluded(sym: Symbol, nowMs: number): boolean {
    return nowMs < (this.excludedUntil.get(sym) ?? 0);
  }
}

export interface ChainlinkConfig {
  client: PublicClient;
  symbols: Symbol[];
  /** Stock Token address per stock symbol (from the issuer's canonical list). */
  tokens: Partial<Record<Symbol, Address>>;
}

export function startChainlink(cfg: ChainlinkConfig, onQuote: (q: Quote) => void, log: (m: string) => void = () => {}): SourceHandle {
  const guard = new MultiplierGuard();
  const decimals = new Map<Symbol, number>();
  let stopped = false;
  let busy = false;
  const feeds = cfg.symbols.map((s) => ({ s, feed: getAddress(FEEDS[s]!) }));

  const readMultipliers = async () => {
    for (const s of cfg.symbols) {
      const token = cfg.tokens[s];
      if (MARKETS[s].cls !== "stock" || !token) continue;
      try {
        const m = await cfg.client.readContract({ address: token, abi: uiMultiplierAbi, functionName: "uiMultiplier" });
        const [, answer] = await cfg.client.readContract({ address: getAddress(FEEDS[s]!), abi: aggregatorAbi, functionName: "latestRoundData" });
        if (guard.noteMultiplier(s, m, answer, Date.now())) log(`chainlink ${s}: multiplier changed without a matching price move; left out until the next session`);
      } catch (err) {
        log(`chainlink ${s} multiplier read failed: ${String(err).slice(0, 120)}`);
      }
    }
  };

  const init = async () => {
    for (const { s, feed } of feeds) decimals.set(s, await cfg.client.readContract({ address: feed, abi: aggregatorAbi, functionName: "decimals" }));
    await readMultipliers();
  };

  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      const res = await cfg.client.multicall({
        contracts: feeds.map(({ feed }) => ({ address: feed, abi: aggregatorAbi, functionName: "latestRoundData" as const })),
        allowFailure: true,
        multicallAddress: CONTRACTS_4663_MULTICALL,
      });
      const recv = Date.now();
      res.forEach((r, i) => {
        if (r.status !== "success") return;
        const { s } = feeds[i]!;
        const [roundId, answer, , updatedAt] = r.result as readonly [bigint, bigint, bigint, bigint, bigint];
        const dec = decimals.get(s);
        const mult = guard.multiplier(s);
        if (dec === undefined || mult === 0n) return;
        guard.noteAnswer(s, answer);
        const px = normaliseRound(answer, dec, mult);
        if (px === null) return;
        onQuote({
          source: "chainlink", symbol: s, px, recvMs: recv, srcTs: Number(updatedAt),
          flags: guard.excluded(s, recv) ? FLAG_CORP_ACTION : 0,
          round: { roundId, answer, decimals: dec, multiplier: mult },
        });
      });
    } catch (err) {
      log(`chainlink read failed: ${String(err).slice(0, 120)}`);
    } finally {
      busy = false;
    }
  };

  let t: ReturnType<typeof setInterval> | undefined;
  let h: ReturnType<typeof setInterval> | undefined;
  init()
    .then(() => {
      if (stopped) return;
      t = setInterval(tick, 1_000);
      h = setInterval(readMultipliers, 3_600_000);
    })
    .catch((err) => log(`chainlink init failed: ${String(err).slice(0, 120)}`));
  return {
    stop() {
      stopped = true;
      if (t) clearInterval(t);
      if (h) clearInterval(h);
    },
  };
}
