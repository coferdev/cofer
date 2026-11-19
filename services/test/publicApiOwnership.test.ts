import { describe, expect, test } from "bun:test";
import { castLine, castLineProblems, readOwnership } from "../src/publicapi/ownership";
import { fakeOwnership, fakePublicApi, getJson, MAINNET, publicServer } from "./publicApiHarness";

describe("GET /v1/proof/ownership", () => {
  test("owner, guardian, pauses, fee and fee wallets, live from the chain", async () => {
    const r = await getJson(publicServer(), "/v1/proof/ownership");
    expect(r.status).toBe(200);
    expect(r.body.data.factory).toEqual({ address: MAINNET.factory, owner: MAINNET.owner, pendingOwner: null, guardian: MAINNET.guardian, depositsPaused: false, creationPaused: false, swapFeeBps: 30, queuedSwapFeeBps: null, queuedSwapFeeEta: null });
    expect(r.body.data.feeRouter).toEqual({ address: MAINNET.feeRouter, owner: MAINNET.owner, pendingOwner: null, sinks: [8000, 1000, 500, 500].map((bps) => ({ address: MAINNET.guardian, bps })) });
    expect(r.body.data.exitsPausable).toBe(false);
    expect(r.body.meta.cacheSeconds).toBe(60);
  });

  test("every value comes with the exact cast line that reads it again", async () => {
    const o = await readOwnership(fakeOwnership());
    expect(o.checks[0]).toEqual({ what: "Factory owner", value: MAINNET.owner, command: `cast call ${MAINNET.factory} "owner()(address)" --rpc-url https://rpc.mainnet.chain.robinhood.com` });
    expect(o.checks.find((c) => c.what === "Fee wallet 2 share (basis points)")).toEqual({ what: "Fee wallet 2 share (basis points)", value: "1000", command: `cast call ${MAINNET.feeRouter} "bps(uint256)(uint16)" 1 --rpc-url https://rpc.mainnet.chain.robinhood.com` });
    expect(o.checks.length).toBe(19);
  });

  test("the cast lines match the contracts' ABI (name, inputs, output, read-only)", async () => {
    const o = await readOwnership(fakeOwnership());
    expect(castLineProblems(o)).toEqual([]);
    const broken = { ...o, checks: [{ what: "x", value: "1", command: castLine(MAINNET.factory, "owner()(uint256)", "https://r") }, { what: "y", value: "1", command: castLine(MAINNET.factory, "setGuardian(address)()", "https://r") }] };
    expect(castLineProblems(broken)).toEqual(["owner()(uint256) does not match the ABI", "setGuardian(address)() does not match the ABI"]);
  });

  test("a hand-over in progress, a pause and a queued fee are shown", async () => {
    const pending = "0x00000000000000000000000000000000000000aa";
    const o = await readOwnership(fakeOwnership({ pendingOwner: pending, depositsPaused: true, pendingSwapFeeBps: 50, pendingSwapFeeEta: 1_900_000_000n }));
    expect(o.factory.pendingOwner).toBe("0x00000000000000000000000000000000000000AA");
    expect(o.factory.depositsPaused).toBe(true);
    expect(o.factory).toMatchObject({ queuedSwapFeeBps: 50, queuedSwapFeeEta: 1_900_000_000 });
  });

  test("the printed RPC is the public one given, never the server's own", async () => {
    const r = await getJson(publicServer(fakePublicApi({ ownership: { ...fakeOwnership(), rpcUrl: "https://rpc.mainnet.chain.robinhood.com" } })), "/v1/proof/ownership");
    expect(r.body.data.checks.every((c: { command: string }) => c.command.endsWith("--rpc-url https://rpc.mainnet.chain.robinhood.com"))).toBe(true);
  });

  test("a failed read answers 503", async () => {
    const r = await getJson(publicServer(fakePublicApi({ ownership: { ...fakeOwnership(), readFactory: async () => Promise.reject(new Error("rpc")) } })), "/v1/proof/ownership");
    expect(r.status).toBe(503);
  });
});
