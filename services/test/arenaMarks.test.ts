import { describe, expect, test } from "bun:test";
import { parsePrice } from "../src/arena/marks/markets";
import { inSession, marketOpen, nextSessionOpen, nyOffsetHours, sessionMinutes, sessionOnDay } from "../src/arena/marks/calendar";
import { FLAG_CORP_ACTION, FLAG_NOT_ONLINE, FLAG_OUTSIDE_RTH, computeMark, type Quote } from "../src/arena/marks/median";
import { LighterBook, parseLighterRest } from "../src/arena/marks/lighter";
import { parseArcusMarkets } from "../src/arena/marks/arcus";
import { MultiplierGuard, normaliseRound } from "../src/arena/marks/chainlink";

const U = (s: string) => Date.parse(s);
const P = (s: string) => parsePrice(s)!;

describe("parsePrice", () => {
  test("decimal text and numbers to 1e8, rounded down", () => {
    expect(parsePrice("63787.3")).toBe(6_378_730_000_000n);
    expect(parsePrice(63784)).toBe(6_378_400_000_000n);
    expect(parsePrice("1.123456789")).toBe(112_345_678n);
  });
  test("refuses junk", () => {
    for (const v of ["", "-1", "1e5", "abc", "0", null, undefined, Number.NaN, "1.2.3"]) expect(parsePrice(v)).toBeNull();
  });
});

describe("calendar", () => {
  test("New York offset follows the US clock change", () => {
    expect(nyOffsetHours(U("2026-11-01T05:59:59Z"))).toBe(-4);
    expect(nyOffsetHours(U("2026-11-01T06:00:00Z"))).toBe(-5);
    expect(nyOffsetHours(U("2027-03-14T06:59:59Z"))).toBe(-5);
    expect(nyOffsetHours(U("2027-03-14T07:00:00Z"))).toBe(-4);
  });
  test("regular session 09:30-16:00 ET", () => {
    const s = sessionOnDay(U("2026-11-19T15:00:00Z"))!; // Thursday, EST
    expect(new Date(s.openMs).toISOString()).toBe("2026-11-19T14:30:00.000Z");
    expect(new Date(s.closeMs).toISOString()).toBe("2026-11-19T21:00:00.000Z");
    const summer = sessionOnDay(U("2026-07-15T15:00:00Z"))!;
    expect(new Date(summer.openMs).toISOString()).toBe("2026-07-15T13:30:00.000Z");
    expect(inSession(U("2026-11-19T14:29:59Z"))).toBe(false);
    expect(inSession(U("2026-11-19T14:30:00Z"))).toBe(true);
    expect(inSession(U("2026-11-19T20:59:59Z"))).toBe(true);
    expect(inSession(U("2026-11-19T21:00:00Z"))).toBe(false);
  });
  test("spec dates: Thanksgiving closed, the day after closes 13:00, Christmas closed", () => {
    expect(sessionOnDay(U("2026-11-26T16:00:00Z"))).toBeNull();
    const fri = sessionOnDay(U("2026-11-27T16:00:00Z"))!;
    expect(fri.early).toBe(true);
    expect(new Date(fri.closeMs).toISOString()).toBe("2026-11-27T18:00:00.000Z");
    expect(sessionOnDay(U("2026-12-24T16:00:00Z"))!.early).toBe(true);
    for (const d of ["2026-12-25", "2027-01-01", "2027-01-18"]) expect(sessionOnDay(U(`${d}T16:00:00Z`))).toBeNull();
    expect(sessionOnDay(U("2026-11-21T16:00:00Z"))).toBeNull(); // Saturday
  });
  test("crypto is always open; next open; session minutes", () => {
    expect(marketOpen("BTC", U("2026-11-26T16:00:00Z"))).toBe(true);
    expect(marketOpen("SPY", U("2026-11-26T16:00:00Z"))).toBe(false);
    expect(new Date(nextSessionOpen(U("2026-11-25T22:00:00Z"))!).toISOString()).toBe("2026-11-27T14:30:00.000Z");
    expect(sessionMinutes(U("2026-11-21T00:00:00Z"), U("2026-11-23T00:00:00Z"))).toBe(0); // weekend
    expect(sessionMinutes(U("2026-11-23T00:00:00Z"), U("2026-11-24T00:00:00Z"))).toBe(390);
    expect(sessionMinutes(U("2026-11-26T00:00:00Z"), U("2026-11-28T00:00:00Z"))).toBe(210); // closed + early close
  });
});

const T = U("2026-11-19T15:00:00Z"); // stock session open
const q = (source: Quote["source"], px: string, over: Partial<Quote> = {}): Quote => ({
  source, symbol: "BTC", px: P(px), recvMs: T - 500, srcTs: source === "chainlink" ? Math.floor(T / 1000) - 60 : 0, flags: 0, ...over,
});

describe("mark rule", () => {
  test("median of three, rounded down to the tick", () => {
    const m = computeMark("BTC", [q("lighter", "63800.07"), q("arcus", "63790"), q("chainlink", "63805")], T, null);
    expect(m.status).toBe("OK");
    expect(m.mark).toBe(P("63800.0"));
    expect(m.used.sort()).toEqual(["arcus", "chainlink", "lighter"]);
    expect(m.venueFreshFromMs).toBe(T - 500);
  });
  test("two sources: floor of the mean", () => {
    const m = computeMark("ETH", [q("lighter", "1806.05", { symbol: "ETH" }), q("arcus", "1806.02", { symbol: "ETH" })], T, null);
    expect(m.mark).toBe(P("1806.03"));
  });
  test("one source is NO_QUORUM", () => {
    expect(computeMark("BTC", [q("lighter", "63800")], T, null).status).toBe("NO_QUORUM");
  });
  test("over 1% apart is DIVERGED; exactly 1% is fine", () => {
    expect(computeMark("BTC", [q("lighter", "100000"), q("arcus", "101000.01")], T, null).status).toBe("DIVERGED");
    expect(computeMark("BTC", [q("lighter", "100000"), q("arcus", "101000")], T, null).status).toBe("OK");
  });
  test("stale venue quotes (over 5 s) and old Chainlink rounds (over 24 h) drop out", () => {
    expect(computeMark("BTC", [q("lighter", "63800", { recvMs: T - 5_001 }), q("arcus", "63800")], T, null).status).toBe("NO_QUORUM");
    expect(computeMark("BTC", [q("chainlink", "63800", { srcTs: Math.floor(T / 1000) - 86_401 }), q("arcus", "63800")], T, null).status).toBe("NO_QUORUM");
    expect(computeMark("BTC", [q("chainlink", "63800", { srcTs: Math.floor(T / 1000) - 86_400 }), q("arcus", "63800")], T, null).status).toBe("OK");
  });
  test("a quote received after the tick does not count", () => {
    expect(computeMark("BTC", [q("lighter", "63800", { recvMs: T + 1 }), q("arcus", "63800")], T, null).status).toBe("NO_QUORUM");
  });
  test("jump over 5% needs all three sources", () => {
    const prev = P("60000");
    expect(computeMark("BTC", [q("lighter", "63800"), q("arcus", "63800")], T, prev).status).toBe("SUSPECT");
    expect(computeMark("BTC", [q("lighter", "63800"), q("arcus", "63800"), q("chainlink", "63800")], T, prev).status).toBe("OK");
    expect(computeMark("BTC", [q("lighter", "62900"), q("arcus", "62900")], T, prev).status).toBe("OK"); // 4.8%
  });
  test("stocks: closed outside the session; Arcus outside RTH and Chainlink after a corporate action drop out", () => {
    const s = (src: Quote["source"], over: Partial<Quote> = {}) => q(src, "153.10", { symbol: "NVDA", ...over });
    expect(computeMark("NVDA", [s("lighter"), s("arcus"), s("chainlink")], T, null).status).toBe("OK");
    const night = U("2026-11-19T23:00:00Z");
    expect(computeMark("NVDA", [s("lighter", { recvMs: night }), s("arcus", { recvMs: night })], night, null).status).toBe("CLOSED");
    expect(computeMark("NVDA", [s("lighter"), s("arcus", { flags: FLAG_OUTSIDE_RTH })], T, null).status).toBe("NO_QUORUM");
    expect(computeMark("NVDA", [s("lighter"), s("chainlink", { flags: FLAG_CORP_ACTION })], T, null).status).toBe("NO_QUORUM");
    expect(computeMark("BTC", [q("lighter", "63800"), q("arcus", "63800", { flags: FLAG_NOT_ONLINE })], T, null).status).toBe("NO_QUORUM");
  });
});

describe("source parsers", () => {
  test("Lighter REST: last trade price, market id must match the name", () => {
    const qs = parseLighterRest({ order_book_details: [
      { market_id: 1, symbol: "BTC", last_trade_price: 63784, status: "active" },
      { market_id: 0, symbol: "SOL", last_trade_price: 74.7, status: "active" },
      { market_id: 15, symbol: "NVDA", last_trade_price: 153.1, status: "inactive" },
    ] }, 1000);
    expect(qs.map((x) => [x.symbol, x.px, x.flags])).toEqual([["BTC", P("63784"), 0], ["NVDA", P("153.1"), FLAG_NOT_ONLINE]]);
  });
  test("Lighter book: snapshot, updates, removal, crossed book", () => {
    const b = new LighterBook("BTC");
    b.apply({ type: "subscribed/order_book", order_book: { offset: 10, asks: [{ price: "63801.8", size: "0.8" }, { price: "63803.3", size: "0.1" }], bids: [{ price: "63784.4", size: "0.2" }] } });
    expect(b.mid()).toBe((P("63801.8") + P("63784.4")) / 2n);
    b.apply({ type: "update/order_book", order_book: { offset: 11, asks: [{ price: "63801.8", size: "0.00000" }], bids: [] } });
    expect(b.mid()).toBe((P("63803.3") + P("63784.4")) / 2n);
    expect(b.apply({ type: "update/order_book", order_book: { offset: 11, asks: [], bids: [{ price: "1", size: "1" }] } })).toBe(false);
    b.apply({ type: "update/order_book", order_book: { offset: 12, asks: [], bids: [{ price: "63900", size: "1" }] } });
    expect(b.mid()).toBeNull();
  });
  test("Arcus: oracle price and flags", () => {
    const qs = parseArcusMarkets({ markets: [
      { baseAsset: "BTC", quoteAsset: "USD", oraclePrice: "63764.2", isOutsideRth: false, status: "ONLINE" },
      { baseAsset: "NVDA", quoteAsset: "USD", oraclePrice: "153.0", isOutsideRth: true, status: "ONLINE" },
      { baseAsset: "DOGE", quoteAsset: "USD", oraclePrice: "0.1", status: "ONLINE" },
    ] }, 5);
    expect(qs.map((x) => [x.symbol, x.px, x.flags])).toEqual([["BTC", P("63764.2"), 0], ["NVDA", P("153.0"), FLAG_OUTSIDE_RTH]]);
  });
  test("Chainlink: divide by uiMultiplier; exclude after a multiplier jump with no price move", () => {
    expect(normaliseRound(30_000_000_000n, 8, 10n ** 18n)).toBe(P("300"));
    expect(normaliseRound(30_000_000_000n, 8, 2n * 10n ** 18n)).toBe(P("150"));
    expect(normaliseRound(0n, 8, 10n ** 18n)).toBeNull();
    const g = new MultiplierGuard();
    const now = U("2026-11-19T15:00:00Z");
    g.noteAnswer("TSLA", 40_000_000_000n);
    expect(g.noteMultiplier("TSLA", 10n ** 18n, 40_000_000_000n, now)).toBe(false);
    // split: multiplier doubles and the token feed doubles too -> fine
    expect(g.noteMultiplier("TSLA", 2n * 10n ** 18n, 80_000_000_000n, now)).toBe(false);
    g.noteAnswer("TSLA", 80_000_000_000n);
    // multiplier moves again but the feed does not -> left out until the next session
    expect(g.noteMultiplier("TSLA", 4n * 10n ** 18n, 80_000_000_000n, now)).toBe(true);
    expect(g.excluded("TSLA", now)).toBe(true);
    expect(g.excluded("TSLA", U("2026-11-20T14:30:00Z"))).toBe(false);
    expect(g.multiplier("BTC")).toBe(10n ** 18n);
  });
});
