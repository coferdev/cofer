import { describe, expect, test } from "bun:test";
import { approvalsNeeded } from "../src/publicapi/pots";
import { fakePots, fakePublicApi, getJson, POT, publicServer, T_TSTA, T_USDG } from "./publicApiHarness";

describe("GET /v1/pots/:pot", () => {
  test("members, vote rule, exit window and holdings, raw balances with decimals", async () => {
    const r = await getJson(publicServer(), `/v1/pots/${POT}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({
      address: POT,
      createdBlock: "147500000",
      memberCount: 3,
      voteRule: { threshold: 0, thresholdBps: 6000, approvalsNeeded: 2 },
      exitWindowSeconds: 21600,
      depositsOpen: true,
      maxSlipBps: 300,
      entrySpreadBps: 50,
      totalShares: "25000000000000000000",
      epoch: "2",
      planPaidUntil: 1800000000,
      assets: [
        { asset: T_USDG, symbol: "USDG", decimals: 6, rawBalance: "25000000", distributable: "24000000" },
        { asset: T_TSTA, symbol: "TSTA", decimals: 18, rawBalance: "100000000000000000", distributable: "100000000000000000" },
      ],
    });
    expect(r.body.meta.cacheSeconds).toBe(30);
  });

  test("a lower-case address works and answers with the checksummed one", async () => {
    const r = await getJson(publicServer(), `/v1/pots/${POT.toLowerCase()}`);
    expect(r.body.data.address).toBe(POT);
  });

  test("not an address is 400; an address the factory did not make is 404", async () => {
    expect((await getJson(publicServer(), "/v1/pots/0x123")).status).toBe(400);
    const r = await getJson(publicServer(), "/v1/pots/0x0000000000000000000000000000000000000abc");
    expect(r.status).toBe(404);
    expect(r.body.error.message).toBe("No Cofer group account at this address.");
  });

  test("approvals needed, as the pot counts them", () => {
    expect(approvalsNeeded(3, 0, 6000)).toBe(2);
    expect(approvalsNeeded(5, 0, 6000)).toBe(3);
    expect(approvalsNeeded(1, 0, 6000)).toBe(1);
    expect(approvalsNeeded(4, 3, 0)).toBe(3);
    expect(approvalsNeeded(2, 3, 0)).toBe(2);
    expect(approvalsNeeded(0, 1, 0)).toBe(0);
  });

  test("never a Telegram field: the answer is chain data only", async () => {
    const r = await getJson(publicServer(), `/v1/pots/${POT}`);
    expect(JSON.stringify(r.body)).not.toMatch(/chat|title|tg|username|@/i);
  });

  test("one chain read per group per 30 seconds; a plan never paid is null", async () => {
    let reads = 0;
    const app = publicServer(fakePublicApi({ pots: fakePots({ planPaidUntil: async () => (reads++, 0n) }) }));
    await Promise.all([1, 2, 3].map(() => app.request(`/v1/pots/${POT}`)));
    expect(reads).toBe(1);
    expect((await getJson(app, `/v1/pots/${POT}`)).body.data.planPaidUntil).toBeNull();
  });
});
