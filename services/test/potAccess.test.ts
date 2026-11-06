/**
 * Signer API pot.get and pot.previewExit show a pot only to an active member of it. Anyone else, and
 * a pot that does not exist, get the same NOT_FOUND, so the answer never reveals whether a pot exists.
 * The database and chain are in-memory stand-ins; a refused call must never reach the chain.
 */
import { describe, expect, test } from "bun:test";
import { TRPCError } from "@trpc/server";
import { is, Param, SQL } from "drizzle-orm";
import { getAddress } from "viem";
import { appRouter, POT_NOT_FOUND, type ApiCtx } from "../src/api/router";
import type { LinkClaims } from "../src/core/linkToken";

const POT = getAddress("0x2D3365a056074f6cd35C943EDcE644FAE7Eb8A45");
const OTHER_POT = getAddress("0x1111111111111111111111111111111111111111");
const MISSING_POT = getAddress("0x9999999999999999999999999999999999999999");
const USDG = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
const ALICE = { tg: 101, address: getAddress("0x000000000000000000000000000000000000a11c") }; // member of POT
const BOB = { tg: 102, address: getAddress("0x00000000000000000000000000000000000b0b00") }; // member of OTHER_POT only
const CAROL = { tg: 103, address: getAddress("0x00000000000000000000000000000000000c0c00") }; // left POT (inactive)
const DAVE = { tg: 104 }; // no key yet

/** The plain values inside a drizzle condition, in order. */
function paramsOf(x: unknown, out: unknown[] = []): unknown[] {
  if (x === null || x === undefined) return out;
  if (typeof x !== "object") return out.push(x), out; // a value written straight into a sql`` template
  if (is(x, Param)) return out.push((x as Param).value), out;
  if (is(x, SQL)) for (const c of (x as SQL).queryChunks) paramsOf(c, out);
  return out;
}

const users = [
  { tgId: ALICE.tg, address: ALICE.address.toLowerCase() }, // stored case does not matter
  { tgId: BOB.tg, address: BOB.address },
  { tgId: CAROL.tg, address: CAROL.address },
  { tgId: DAVE.tg, address: null },
];
const members = [
  { pot: POT, address: ALICE.address, active: true },
  { pot: OTHER_POT, address: BOB.address, active: true },
  { pot: POT, address: CAROL.address, active: false },
];

function setup() {
  const reached = { chain: 0, holdings: 0 };
  const db = {
    query: {
      users: { findFirst: async (q: { where: unknown }) => users.find((u) => paramsOf(q.where).includes(u.tgId)) },
      members: {
        findFirst: async (q: { where: unknown }) => {
          const [pot, addr, active] = paramsOf(q.where);
          return members.find((m) => m.pot === pot && m.address.toLowerCase() === addr && m.active === active);
        },
      },
    },
    select: () => ({ from: () => ({ where: async () => ((reached.holdings++), [{ pot: POT, asset: USDG, rawBalance: "100", reserved: "0", valueUsdg: "100" }]) }) }),
  };
  const reads: Record<string, unknown> = {
    members: [ALICE.address],
    threshold: 1,
    thresholdBps: 6000,
    config: [21600, 100, 50, true],
    epoch: 3n,
    heldAssets: [USDG],
    totalShares: 1000n,
    distributable: 999n,
  };
  const client = {
    readContract: async ({ functionName }: { functionName: string }) => {
      reached.chain++;
      return reads[functionName];
    },
  };
  const caller = (tg: number) => {
    const session: LinkClaims = { tg, chat: tg, p: "session", ref: "", exp: Math.floor(Date.now() / 1000) + 600, jti: "s" };
    return appRouter.createCaller({ deps: { db, client } as unknown as ApiCtx["deps"], cards: null, secret: "x".repeat(40), session });
  };
  return { caller, reached };
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof TRPCError ? `${e.code}: ${e.message}` : `not a TRPCError: ${String(e)}`;
  }
}
const NOT_FOUND = `NOT_FOUND: ${POT_NOT_FOUND}`;

describe("pot.get and pot.previewExit: active members only", () => {
  test("a member gets the pot", async () => {
    const { caller } = setup();
    const r = await caller(ALICE.tg).pot.get({ pot: POT });
    expect([r.threshold, r.thresholdBps, r.guardDelay, r.epoch, r.totalShares]).toEqual([1, 6000, 21600, "3", "1000"]);
    expect(r.holdings.length).toBe(1);
  });

  test("a member gets their exit preview (exact, rounded down like the contract)", async () => {
    const { caller } = setup();
    expect(await caller(ALICE.tg).pot.previewExit({ pot: POT, shares: "500" })).toEqual([{ asset: USDG, amount: "499" }]);
  });

  for (const [who, tg] of [
    ["a member of another pot", BOB.tg],
    ["a former member (exited or removed)", CAROL.tg],
    ["someone with no key yet", DAVE.tg],
  ] as const) {
    test(`${who} -> not found, and the chain is never read`, async () => {
      const { caller, reached } = setup();
      expect(await refusal(caller(tg).pot.get({ pot: POT }))).toBe(NOT_FOUND);
      expect(await refusal(caller(tg).pot.previewExit({ pot: POT, shares: "1" }))).toBe(NOT_FOUND);
      expect(reached).toEqual({ chain: 0, holdings: 0 });
    });
  }

  test("a pot that does not exist gets exactly the same answer as someone else's pot", async () => {
    const { caller, reached } = setup();
    const missing = await refusal(caller(ALICE.tg).pot.get({ pot: MISSING_POT }));
    const notMine = await refusal(caller(ALICE.tg).pot.get({ pot: OTHER_POT }));
    expect(missing).toBe(NOT_FOUND);
    expect(notMine).toBe(missing);
    expect(await refusal(caller(ALICE.tg).pot.previewExit({ pot: MISSING_POT, shares: "1" }))).toBe(missing);
    expect(reached).toEqual({ chain: 0, holdings: 0 });
  });
});
