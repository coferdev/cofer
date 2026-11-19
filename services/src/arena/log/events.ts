/**
 * The game log's events (spec §4.7): encoded_i = abi.encode(uint8 type, uint64 seq, bytes payload), each payload an
 * ABI tuple with a fixed layout per type, so the engine, the signers and the public replay read the same bytes.
 */
import { type Hex, decodeAbiParameters, encodeAbiParameters, keccak256, toBytes } from "viem";
import type { Order } from "../engine/orders";

export const EV = {
  GameOpen: 1,
  TickRef: 3,
  OrderIn: 4,
  OrderReject: 5,
  Fill: 6,
  Cancel: 7,
  OptionList: 8,
  OptionFill: 9,
  OptionSettle: 10,
  Eliminate: 11,
  Halt: 12,
  Checkpoint: 13,
  Flag: 14,
  GameClose: 15,
} as const;
export type EvName = keyof typeof EV;

const P = (...types: string[]) => types.map((type) => ({ type }));

/** Payload layouts. Strings are short codes or ids; numbers that can exceed 2^53 are uint/int256. */
export const PAYLOAD: Record<EvName, { type: string }[]> = {
  GameOpen: P("address", "bytes32", "string", "address[]", "bytes[]", "uint64", "uint64", "uint64", "uint64[]"),
  TickRef: P("uint64", "uint64", "uint64"), // tape hour, first and last tick ts covered
  OrderIn: P("address", "bytes", "bytes", "uint64"), // seat, order bytes, P-256 signature, recvTs
  OrderReject: P("string", "string"), // order ref (clientId), reason
  Fill: P("string", "uint64", "string", "string", "int256", "uint256", "uint256", "int256"), // ref, tick ts, symbol, product, signed qty, px, fee, realised
  Cancel: P("string", "string", "string"), // ref, by, reason
  OptionList: P("string", "uint64", "string[]", "uint256"), // symbol, expiry, series ids, σ
  OptionFill: P("string", "string", "int256", "int256"), // ref, series, contracts (+buy −sell), chips (−paid +received)
  OptionSettle: P("string", "uint64", "uint256", "address[]", "uint256[]"), // symbol, expiry, px, seats, credits
  Eliminate: P("address", "uint64", "int256"),
  Halt: P("string", "string"), // symbol, status
  Checkpoint: P("uint64", "bytes32"),
  Flag: P("string", "address[]", "int256[]"),
  GameClose: P("uint64", "bytes"), // endAt, standings rows (abi-encoded)
};

export interface LogEvent {
  type: EvName;
  seq: bigint;
  payload: readonly unknown[];
}

export function encodeLogEvent(e: LogEvent): Hex {
  const payload = encodeAbiParameters(PAYLOAD[e.type], e.payload as never);
  return encodeAbiParameters(P("uint8", "uint64", "bytes"), [EV[e.type], e.seq, payload]);
}

const NAME_BY_CODE = new Map<number, EvName>(Object.entries(EV).map(([k, v]) => [v, k as EvName]));

export function decodeLogEvent(enc: Hex): LogEvent {
  const [code, seq, payload] = decodeAbiParameters(P("uint8", "uint64", "bytes"), enc) as [number, bigint, Hex];
  const type = NAME_BY_CODE.get(code);
  if (!type) throw new Error(`unknown event type ${code}`);
  return { type, seq, payload: decodeAbiParameters(PAYLOAD[type], payload) };
}

/**
 * The canonical order bytes the session key signs (spec §4.4): one fixed ABI tuple, absent fields as zero values, the
 * table address first so an order for one table can never be replayed on another.
 */
const ORDER = P(
  "address", "address", "uint256", "string", "string", "string", "string", "uint256", "uint256", "uint256", "uint256",
  "uint256", "uint256", "bool", "string", "uint256", "uint64", "uint32", "string", "string", "uint64",
);

export function encodeOrder(table: Hex, o: Order): Hex {
  const opt = o.option;
  return encodeAbiParameters(ORDER, [
    table, o.seat as Hex, o.nonce, o.kind, o.symbol, o.product, o.side ?? "",
    o.qty ?? 0n, o.notional ?? 0n, o.pctFreeBps ?? 0n, o.leverage ?? 0n, o.limitPx ?? 0n, o.triggerPx ?? 0n, o.reduceOnly ?? false,
    opt?.type ?? "", opt?.strike ?? 0n, BigInt(opt?.expiry ?? 0), Number(opt?.contracts ?? 0n),
    o.cancelRef ?? "", o.clientId, BigInt(o.validUntil ?? 0),
  ] as never);
}

export function decodeOrder(enc: Hex): { table: Hex; order: Order } {
  const v = decodeAbiParameters(ORDER, enc) as unknown[];
  const s = (i: number) => v[i] as string;
  const n = (i: number) => v[i] as bigint;
  const o: Order = { seat: s(1).toLowerCase(), nonce: n(2), kind: s(3) as Order["kind"], symbol: s(4), product: s(5) as Order["product"], clientId: s(19) };
  if (s(6)) o.side = s(6) as Order["side"];
  if (n(7)) o.qty = n(7);
  if (n(8)) o.notional = n(8);
  if (n(9)) o.pctFreeBps = n(9);
  if (n(10)) o.leverage = n(10);
  if (n(11)) o.limitPx = n(11);
  if (n(12)) o.triggerPx = n(12);
  if (v[13]) o.reduceOnly = true;
  if (s(14)) o.option = { type: s(14) as "CALL" | "PUT", strike: n(15), expiry: Number(n(16)), contracts: BigInt(v[17] as number) };
  if (s(18)) o.cancelRef = s(18);
  if (n(20)) o.validUntil = Number(n(20));
  return { table: (v[0] as string).toLowerCase() as Hex, order: o };
}

export const orderDigest = (table: Hex, o: Order) => keccak256(toBytes(encodeOrder(table, o)));
