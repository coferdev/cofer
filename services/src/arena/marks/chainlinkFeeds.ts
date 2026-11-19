/** The feed and Multicall3 addresses the marks service reads, taken from chain/addresses.ts. */
import { FEEDS as ALL, RHC } from "../../chain/addresses";
import type { Symbol } from "./markets";

export const FEEDS: Partial<Record<Symbol, string>> = { BTC: ALL.BTC, ETH: ALL.ETH, NVDA: ALL.NVDA, TSLA: ALL.TSLA, SPY: ALL.SPY };
export const CONTRACTS_4663_MULTICALL = RHC.MULTICALL3;
