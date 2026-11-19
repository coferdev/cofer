import { describe, expect, test } from "bun:test";
import type { Mark } from "../src/arena/marks/median";
import type { Symbol } from "../src/arena/marks/markets";
import { type Book, type Emitted, type Order, PRACTICE_RULES, addSeat, ingest, newBook, onTick } from "../src/arena/engine/orders";

const PX = (n: number) => BigInt(Math.round(n * 1e8));
const T0 = 1_800_000_000_000;
const A = "0xA";

const mk = (symbol: Symbol, px: bigint | null, freshFrom: number, status: Mark["status"] = "OK"): Mark => ({
  symbol, status, mark: px, used: ["lighter", "arcus", "chainlink"], venueFreshFromMs: freshFrom,
});
const marks = (...m: Mark[]) => new Map(m.map((x) => [x.symbol as string, x]));

let nonce = 0n;
let seq = 0;
const order = (o: Partial<Order>): Order => ({ seat: A, nonce: ++nonce, kind: "MARKET", symbol: "BTC", product: "PERP", side: "BUY", clientId: `c${nonce}`, ...o });
const book = () => {
  const b = newBook(PRACTICE_RULES);
  addSeat(b, A);
  return b;
};
const fills = (e: Emitted[]) => e.filter((x) => x.t === "Fill");
const rejects = (e: Emitted[]) => e.filter((x) => x.t === "Reject").map((x) => (x as { reason: string }).reason);
/** A tick at T0+s seconds whose venue quotes were all received at that same instant. */
const tick = (b: Book, s: number, px: bigint, sym: Symbol = "BTC") => onTick(b, T0 + s * 1000, marks(mk(sym, px, T0 + s * 1000)));

describe("arena orders", () => {
  test("MARKET fills at the first tick after recvTs + 1 s whose mark is fresh after the order, at that mark", () => {
    const b = book();
    expect(ingest(b, order({ qty: PX(0.01), leverage: 2n }), T0, ++seq)[0]!.t).toBe("Accepted");
    expect(fills(tick(b, 1, PX(100_000)))).toHaveLength(0); // ts = recv + Δ: not after it
    // a later tick whose mark still uses a quote received before recv + Δ: not fresh after the order
    expect(fills(onTick(b, T0 + 2000, marks(mk("BTC", PX(100_100), T0 + 900))))).toHaveLength(0);
    const f = fills(tick(b, 3, PX(100_200)));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ px: PX(100_200), dq: PX(0.01) });
    expect(b.seats.get(A)!.ledger.perps.get("BTC")!.entry).toBe(PX(100_200));
  });

  test("no fresh valid mark for 30 s after the delay cancels a MARKET with NO_MARK", () => {
    const b = book();
    ingest(b, order({ qty: PX(0.01) }), T0, ++seq);
    expect(rejects(onTick(b, T0 + 30_000, marks(mk("BTC", null, T0, "DIVERGED"))))).toEqual([]);
    expect(rejects(onTick(b, T0 + 31_001, marks(mk("BTC", null, T0, "NO_QUORUM"))))).toEqual(["NO_MARK"]);
    expect(b.live).toHaveLength(0);
  });

  test("the 60 s minimum hold: a reduce before it is refused with HOLD, after it fills", () => {
    const b = book();
    ingest(b, order({ qty: PX(0.01), leverage: 5n }), T0, ++seq);
    tick(b, 2, PX(100_000)); // opened at T0+2 s
    ingest(b, order({ side: "SELL", qty: PX(0.01) }), T0 + 10_000, ++seq);
    expect(rejects(tick(b, 12, PX(101_000)))).toEqual(["HOLD"]);
    ingest(b, order({ side: "SELL", qty: PX(0.01) }), T0 + 61_000, ++seq);
    const f = fills(tick(b, 63, PX(101_000)));
    expect(f).toHaveLength(1);
    expect(b.seats.get(A)!.ledger.perps.has("BTC")).toBe(false);
    // 0.01 BTC × +1,000 = +10 chips realised, before fees
    expect((f[0] as { realised: bigint }).realised).toBe(10_000_000n);
  });

  test("a reversal counts as a reduce for the hold", () => {
    const b = book();
    ingest(b, order({ qty: PX(0.01) }), T0, ++seq);
    tick(b, 2, PX(100_000));
    ingest(b, order({ side: "SELL", qty: PX(0.02) }), T0 + 5_000, ++seq);
    expect(rejects(tick(b, 7, PX(100_000)))).toEqual(["HOLD"]);
  });

  test("LIMIT rests, then fills at the mark (not the limit) once the mark is at or through it", () => {
    const b = book();
    ingest(b, order({ kind: "LIMIT", qty: PX(0.01), limitPx: PX(99_000) }), T0, ++seq);
    expect(fills(tick(b, 2, PX(99_500)))).toHaveLength(0);
    const f = fills(tick(b, 3, PX(98_900)));
    expect(f[0]).toMatchObject({ px: PX(98_900) });
  });

  test("STOP: arms, a cross inside the hold stays armed, fires after the hold, fills at the next fresh tick", () => {
    const b = book();
    ingest(b, order({ qty: PX(0.01), leverage: 2n }), T0, ++seq);
    tick(b, 2, PX(100_000));
    ingest(b, order({ kind: "STOP", side: "SELL", triggerPx: PX(99_000) }), T0 + 3_000, ++seq);
    const early = tick(b, 30, PX(98_000));
    expect(early.filter((e) => e.t === "Fired")).toHaveLength(0);
    const fired = tick(b, 62, PX(98_500));
    expect(fired.filter((e) => e.t === "Fired")).toHaveLength(1);
    expect(fills(fired)).toHaveLength(0);
    expect(fills(tick(b, 63, PX(98_400)))).toHaveLength(0); // ts = fired + Δ: not after it
    const f = fills(tick(b, 64, PX(98_300)));
    expect(f[0]).toMatchObject({ px: PX(98_300), dq: -PX(0.01) });
  });

  test("TAKE_PROFIT on a short fires when the mark falls to the trigger", () => {
    const b = book();
    ingest(b, order({ side: "SELL", qty: PX(1), symbol: "ETH", leverage: 2n }), T0, ++seq);
    tick(b, 2, PX(4_000), "ETH");
    ingest(b, order({ kind: "TAKE_PROFIT", side: "BUY", symbol: "ETH", triggerPx: PX(3_800) }), T0 + 3_000, ++seq);
    expect(tick(b, 70, PX(3_850), "ETH").filter((e) => e.t === "Fired")).toHaveLength(0);
    expect(tick(b, 71, PX(3_790), "ETH").filter((e) => e.t === "Fired")).toHaveLength(1);
    expect(fills(tick(b, 73, PX(3_795), "ETH"))[0]).toMatchObject({ dq: PX(1) });
  });

  test("CANCEL removes a resting order before it fills", () => {
    const b = book();
    ingest(b, order({ kind: "LIMIT", qty: PX(0.01), limitPx: PX(90_000), clientId: "L1" }), T0, ++seq);
    expect(ingest(b, order({ kind: "CANCEL", cancelRef: "L1" }), T0 + 1_500, ++seq)[0]!.t).toBe("Cancelled");
    expect(fills(tick(b, 3, PX(80_000)))).toHaveLength(0);
    expect(ingest(b, order({ kind: "CANCEL", cancelRef: "L1" }), T0 + 4_000, ++seq).map((e) => e.t)).toEqual(["Reject"]);
  });

  test("ingress refusals: NONCE, RATE, CAP (leverage over the mode cap), MARKET, QTY", () => {
    const b = book();
    expect(rejects(ingest(b, { ...order({ qty: 1n }), nonce: 0n }, T0, ++seq))).toEqual([]);
    expect(rejects(ingest(b, { ...order({ qty: 1n }), nonce: 0n }, T0 + 10, ++seq))).toEqual(["NONCE"]);
    expect(rejects(ingest(b, order({ qty: 1n }), T0 + 20, ++seq))).toEqual([]);
    expect(rejects(ingest(b, order({ qty: 1n }), T0 + 30, ++seq))).toEqual(["RATE"]); // third in one second
    expect(rejects(ingest(b, order({ qty: 1n, leverage: 21n }), T0 + 2_000, ++seq))).toEqual(["CAP"]);
    expect(rejects(ingest(b, order({ qty: 1n, symbol: "NVDA", leverage: 11n }), T0 + 4_000, ++seq))).toEqual(["CAP"]);
    expect(rejects(ingest(b, order({ qty: 1n, symbol: "DOGE" }), T0 + 6_000, ++seq))).toEqual(["MARKET"]);
    expect(rejects(ingest(b, order({ qty: 1n, notional: 5n }), T0 + 8_000, ++seq))).toEqual(["QTY"]);
  });

  test("a MARKET on a closed stock market is refused with CLOSED_MARKET", () => {
    const b = book();
    ingest(b, order({ symbol: "NVDA", qty: PX(1) }), T0, ++seq);
    expect(rejects(onTick(b, T0 + 2_000, marks(mk("NVDA", null, T0 + 2_000, "CLOSED"))))).toEqual(["CLOSED_MARKET"]);
  });

  test("100% of free margin is a valid order (the fee is left room for)", () => {
    const b = book();
    ingest(b, order({ pctFreeBps: 10_000n, leverage: 10n }), T0, ++seq);
    const e = tick(b, 2, PX(100_000));
    expect(rejects(e)).toEqual([]);
    expect(fills(e)).toHaveLength(1);
    expect(b.seats.get(A)!.ledger.cash).toBeGreaterThanOrEqual(0n);
  });

  test("due orders run in seq order: the second one that no longer fits is refused with MARGIN", () => {
    const b = book();
    ingest(b, order({ pctFreeBps: 9_000n, leverage: 1n }), T0, ++seq);
    ingest(b, order({ pctFreeBps: 9_000n, leverage: 1n, symbol: "ETH" }), T0 + 100, ++seq);
    const e = onTick(b, T0 + 2_000, marks(mk("BTC", PX(100_000), T0 + 2_000), mk("ETH", PX(4_000), T0 + 2_000)));
    expect(fills(e).map((f) => (f as { symbol: string }).symbol)).toEqual(["BTC", "ETH"]);
    // the ETH order was sized on free margin at its own turn (10% left), so it still fits
    expect(rejects(e)).toEqual([]);
    ingest(b, order({ qty: PX(1_000), leverage: 1n, symbol: "ETH" }), T0 + 3_000, ++seq);
    expect(rejects(onTick(b, T0 + 5_000, marks(mk("BTC", PX(100_000), T0 + 5_000), mk("ETH", PX(4_000), T0 + 5_000))))).toEqual(["MARGIN"]);
  });

  test("CLOSE * flattens perps and spot together at one tick", () => {
    const b = book();
    ingest(b, order({ qty: PX(0.01), leverage: 3n }), T0, ++seq);
    ingest(b, order({ symbol: "ETH", product: "SPOT", qty: PX(0.1) }), T0 + 600, ++seq);
    onTick(b, T0 + 2_000, marks(mk("BTC", PX(100_000), T0 + 2_000), mk("ETH", PX(4_000), T0 + 2_000)));
    ingest(b, order({ kind: "CLOSE", symbol: "*" }), T0 + 70_000, ++seq);
    const e = onTick(b, T0 + 72_000, marks(mk("BTC", PX(100_500), T0 + 72_000), mk("ETH", PX(4_100), T0 + 72_000)));
    expect(fills(e)).toHaveLength(2);
    const s = b.seats.get(A)!.ledger;
    expect(s.perps.size + s.spot.size).toBe(0);
  });

  test("replay: the same log gives the same events and the same ledger, byte for byte", () => {
    const run = () => {
      const b = newBook(PRACTICE_RULES);
      addSeat(b, A);
      let n = 0n;
      const o = (x: Partial<Order>) => ({ seat: A, nonce: ++n, kind: "MARKET", symbol: "BTC", product: "PERP", side: "BUY", clientId: `r${n}`, ...x }) as Order;
      const out: Emitted[] = [];
      out.push(...ingest(b, o({ qty: PX(0.05), leverage: 4n }), T0, 1));
      for (let s = 1; s < 200; s++) {
        if (s === 80) out.push(...ingest(b, o({ kind: "STOP", side: "SELL", triggerPx: PX(99_200) }), T0 + s * 1000 + 3, 2));
        if (s === 90) out.push(...ingest(b, o({ kind: "LIMIT", side: "BUY", qty: PX(0.02), limitPx: PX(99_500), leverage: 2n }), T0 + s * 1000 + 7, 3));
        out.push(...onTick(b, T0 + s * 1000, marks(mk("BTC", PX(100_000 - s * 5), T0 + s * 1000 - 200))));
      }
      return JSON.stringify({ out, cash: b.seats.get(A)!.ledger.cash, perps: [...b.seats.get(A)!.ledger.perps] }, (_, v) => (typeof v === "bigint" ? v.toString() : v));
    };
    const a = run();
    expect(run()).toBe(a);
    expect(a).toContain('"t":"Fill"');
  });
});
