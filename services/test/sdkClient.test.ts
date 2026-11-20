/** The SDK's typed client against the real API server (fake data, a local port): every method, and the shapes. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import recorded from "./fixtures/tx-receipts-46630.json";
import { createCoferClient, CoferApiError, SHAPES } from "../../sdk/src";
import { POT, POT_MEMBERS, publicServer } from "./publicApiHarness";

let server: ReturnType<typeof Bun.serve>;
let base = "";
beforeAll(() => {
  const app = publicServer();
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

const keys = (x: object) => Object.keys(x).filter((k) => k !== "note").sort();

describe("createCoferClient", () => {
  test("every method answers with exactly the fields its type declares", async () => {
    const c = createCoferClient({ baseUrl: base });
    const got: Record<keyof typeof SHAPES, object> = {
      status: await c.status(),
      tx: await c.tx(recorded.kinds.Deposited as `0x${string}`),
      ownership: await c.ownership(),
      pot: await c.pot(POT),
      members: await c.members(POT, { limit: 2 }),
      votes: { votes: await c.votes(POT, { state: "open" }) },
      timeline: await c.timeline(POT),
      exitReceipt: await c.exitReceipt(recorded.kinds.Exited as `0x${string}`),
      depositReceipt: await c.depositReceipt(recorded.kinds.Deposited as `0x${string}`),
      spendReceipt: await c.spendReceipt(recorded.kinds.AllowanceSpent as `0x${string}`),
      voteReceipt: await c.voteReceipt(`0x${"ab".repeat(32)}`),
      keyGroups: await c.keyGroups(POT_MEMBERS[1]!),
      setAsides: await c.setAsides(POT_MEMBERS[0]!),
      adminPending: await c.adminPending(),
      holdings: await c.holdings(POT),
      snapshotProof: await c.snapshotProof(POT),
      fees: await c.fees(POT),
    };
    for (const [name, fields] of Object.entries(SHAPES)) expect(keys(got[name as keyof typeof SHAPES]), name).toEqual([...fields].sort());
    expect((got.members as { members: unknown[] }).members).toHaveLength(2);
  });

  test("an error answer becomes a CoferApiError with the API's own words", async () => {
    const c = createCoferClient({ baseUrl: base });
    const e = await c.pot("0x0000000000000000000000000000000000000abc").catch((x) => x);
    expect(e).toBeInstanceOf(CoferApiError);
    expect([e.status, e.code, e.message]).toEqual([404, "not_found", "No Cofer group account at this address."]);
  });

  test("direct chain reads, without the API", async () => {
    const reads: Record<string, unknown> = { memberCount: 3n, threshold: 0, thresholdBps: 6000, requiredVotes: 2n, config: [21600, 300, 50, true], totalShares: 5n, heldAssets: ["0x14119629e364A53ceda500d0c1111DBB136A7398"], balanceOf: 7n, members: [POT_MEMBERS[0]], memberInfo: { active: true, shares: 5n } };
    const c = createCoferClient({ baseUrl: "http://unused.invalid", chain: { readContract: (async (a: { functionName: string }) => reads[a.functionName]) as never } });
    expect(await c.potFromChain(POT)).toEqual({ address: POT, memberCount: 3, voteRule: { threshold: 0, thresholdBps: 6000, approvalsNeeded: 2 }, exitWindowSeconds: 21600, maxSlipBps: 300, entrySpreadBps: 50, depositsOpen: true, totalShares: "5", assets: [{ asset: "0x14119629e364A53ceda500d0c1111DBB136A7398", rawBalance: "7" }] });
    expect(await c.membersFromChain(POT)).toEqual([{ address: POT_MEMBERS[0]!, active: true, shares: "5" }]);
  });
});
