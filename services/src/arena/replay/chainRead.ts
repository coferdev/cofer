/**
 * Read a table, its registry and the Chainlink rounds from chain for `arena-replay` (public RPC, no keys).
 */
import { type Hex, type PublicClient, createPublicClient, http, parseAbi, parseAbiItem } from "viem";
import { FEEDS } from "../marks/chainlinkFeeds";
import type { OnChainGame } from "./verifyGame";

export const publicClient = (rpc: string) => createPublicClient({ transport: http(rpc) }) as PublicClient;

const TABLE = parseAbi([
  "function rulesHash() view returns (bytes32)",
  "function seats() view returns (address[])",
  "function seatOf(address) view returns (uint16 seatPlusOne, bytes32 sessionKeyHash, bool prizeEligible)",
  "function factory() view returns (address)",
  "function currentResult() view returns (uint8 round, bytes32 digest, address[] podium, bytes32 payoutRoot, uint256 totalPayout)",
  "function params() view returns ((uint8 mode, address token, uint96 buyIn, uint96 prize, uint16 minSeats, uint16 maxSeats, uint64 lockAt, uint64 openUntil, uint32 duration, uint32 disputeWindow, uint32 settleGrace, uint16 disputeBondBps, uint16[] payoutBps, address inviteSigner, bytes32 rulesHash, bool cryptoOnly))",
]);
const FACTORY = parseAbi(["function registry() view returns (address)"]);
const REGISTRY = parseAbi(["function tapeHead(uint64 hourId) view returns (bytes32)"]);
const RECORDED = parseAbiItem(
  "event ResultRecorded(address indexed table, uint8 round, bytes32 digest, bytes32 logHead, bytes32 eventsRoot, bytes32 standingsRoot, string logURI)",
);
const ROUND = parseAbi(["function getRoundData(uint80 roundId) view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)"]);

export async function readGame(client: PublicClient, table: Hex, tapeHours: number[], fromBlock = 0n): Promise<OnChainGame> {
  const at = { address: table, abi: TABLE } as const;
  const [rulesHash, seats, factory, cur, params] = await Promise.all([
    client.readContract({ ...at, functionName: "rulesHash" }),
    client.readContract({ ...at, functionName: "seats" }),
    client.readContract({ ...at, functionName: "factory" }),
    client.readContract({ ...at, functionName: "currentResult" }),
    client.readContract({ ...at, functionName: "params" }),
  ]);
  const registry = await client.readContract({ address: factory, abi: FACTORY, functionName: "registry" });
  const keys = new Map<string, Hex>();
  for (const s of seats) {
    const [, h] = await client.readContract({ ...at, functionName: "seatOf", args: [s] });
    keys.set(s.toLowerCase(), h);
  }
  const [round, digest, podium, payoutRoot, totalPayout] = cur;
  const logs = await client.getLogs({ address: registry, event: RECORDED, args: { table }, fromBlock, toBlock: "latest" });
  const rec = logs.reverse().find((l) => l.args.digest === digest);
  if (!rec) throw new Error(`no ResultRecorded for the table's current digest ${digest}`);
  const tapeHeads = new Map<number, Hex>();
  for (const h of tapeHours) tapeHeads.set(h, await client.readContract({ address: registry, abi: REGISTRY, functionName: "tapeHead", args: [BigInt(h)] }));
  return {
    chainId: await client.getChainId(), registry, table, rulesHash, seats: [...seats], keys,
    podiumSize: params.mode === 0 ? params.payoutBps.length : 0,
    posted: {
      round, digest, logHead: rec.args.logHead!, eventsRoot: rec.args.eventsRoot!, standingsRoot: rec.args.standingsRoot!,
      logURI: rec.args.logURI!, podium: [...podium], payoutRoot, totalPayout,
    },
    tapeHeads,
  };
}

/** Each Chainlink quote against its round on chain: roundId, answer and updatedAt must all match. */
export async function checkChainlink(client: PublicClient, quotes: { symbol: string; roundId: bigint; answer: bigint; updatedAt: number }[]): Promise<string[]> {
  const out: string[] = [];
  for (const q of quotes) {
    const feed = FEEDS[q.symbol as keyof typeof FEEDS];
    if (!feed) {
      out.push(`${q.symbol}: no Chainlink feed known`);
      continue;
    }
    try {
      const [id, answer, , updatedAt] = await client.readContract({ address: feed as Hex, abi: ROUND, functionName: "getRoundData", args: [q.roundId] });
      if (id !== q.roundId || answer !== q.answer || Number(updatedAt) !== q.updatedAt)
        out.push(`${q.symbol} round ${q.roundId}: tape ${q.answer} @${q.updatedAt}, chain ${answer} @${updatedAt}`);
    } catch (e) {
      out.push(`${q.symbol} round ${q.roundId}: not readable on chain (${String(e).split("\n")[0]})`);
    }
  }
  return out;
}
