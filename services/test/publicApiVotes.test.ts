import { describe, expect, test } from "bun:test";
import { describePublic } from "../src/core/describePublic";
import { encodeAction, Kind } from "../src/core/proposal";
import { getJson, POT, POT_MEMBERS, publicServer, T_USDG, TESTNET_TOKENS } from "./publicApiHarness";

const token = async (a: `0x${string}`) => TESTNET_TOKENS[a.toLowerCase()] ?? null;
const pad = (n: number) => `0x${String(n).padStart(64, "0")}`;

describe("GET /v1/pots/:pot/votes", () => {
  test("every state, with summary, approvals out of needed, times and transaction", async () => {
    const r = await getJson(publicServer(), `/v1/pots/${POT}/votes`);
    expect(r.status).toBe(200);
    const v = r.body.data.votes;
    expect(v.map((x: { state: string; madeBy: string }) => `${x.state}/${x.madeBy}`)).toEqual(["executed/outside the bot", "open/bot", "executed/bot", "queued/bot", "expired/bot", "ready/bot"]);
    expect(v[1]).toEqual({ id: pad(1), kind: "send", state: "open", summary: `Send 10 USDG to ${POT_MEMBERS[0]}.`, madeBy: "bot", createdAt: "2026-12-01T10:00:00.000Z", deadline: 1800100000, canRunAfter: null, approvals: 1, approvalsNeeded: 2, txHash: null });
    expect(v[3]).toMatchObject({ kind: "set an allowance", state: "queued", canRunAfter: 1799000000, summary: `Give ${POT_MEMBERS[1]} an allowance of 5 USDG every 168 h.` });
  });

  test("a vote made outside the bot is included, from its on-chain logs", async () => {
    const v = (await getJson(publicServer(), `/v1/pots/${POT}/votes`)).body.data.votes[0];
    expect(v).toEqual({ id: pad(9), kind: "send", state: "executed", summary: "A vote to send, made outside the bot: its full details are in its transaction.", madeBy: "outside the bot", createdAt: null, deadline: null, canRunAfter: 1799500000, approvals: null, approvalsNeeded: 2, txHash: pad(110) });
  });

  test("filter by state", async () => {
    const app = publicServer();
    const q = async (s: string) => (await getJson(app, `/v1/pots/${POT}/votes?state=${s}`)).body.data.votes.map((x: { id: string }) => x.id);
    expect(await q("open")).toEqual([pad(1)]);
    expect(await q("ready")).toEqual([pad(5)]);
    expect(await q("queued")).toEqual([pad(3)]);
    expect(await q("executed")).toEqual([pad(9), pad(2)]);
    expect(await q("expired")).toEqual([pad(4)]);
    expect((await getJson(app, `/v1/pots/${POT}/votes?state=passed`)).status).toBe(400);
    expect((await getJson(app, `/v1/pots/${POT}/votes?limit=101`)).status).toBe(400);
  });

  test("a summary never contains @ or a name: only addresses and amounts from the vote's own bytes", async () => {
    const body = JSON.stringify((await getJson(publicServer(), `/v1/pots/${POT}/votes`)).body);
    expect(body).not.toContain("@");
    expect(body).not.toMatch(/username|proposer|chat|title/i);
  });

  test("every kind of vote reads plainly", async () => {
    const s = (a: Parameters<typeof encodeAction>[0]) => {
      const e = encodeAction(a);
      return describePublic(e.kind, e.data, T_USDG, token);
    };
    expect(await s({ kind: Kind.REMOVE_MEMBER, member: POT_MEMBERS[0]! })).toBe(`Remove member ${POT_MEMBERS[0]}.`);
    expect(await s({ kind: Kind.SET_THRESHOLD, threshold: 2, thresholdBps: 0 })).toBe("Change the vote rule to 2 approval(s).");
    expect(await s({ kind: Kind.SET_CONFIG, guardDelay: 21_600, maxSlipBps: 300, entrySpreadBps: 50, depositsOpen: false })).toBe("Change the settings: exit window 6 h, swap price limit 3%, entry spread 0.5%, deposits closed.");
    expect(await s({ kind: Kind.PAY_PLAN, months: 3, maxCost: 27_000_000n })).toBe("Pay the plan for 3 month(s), at most 27 USDG.");
    expect(await s({ kind: Kind.SWAP, adapter: POT_MEMBERS[2]!, tokenIn: T_USDG, tokenOut: "0x3232dDDE4c6a3FE39Fd17696791D50B54Bc52fFE", amountIn: 50_000_000n, minOut: 10n ** 17n, route: "0x" })).toBe(`Swap 50 USDG for at least 0.1 TSTA, through adapter ${POT_MEMBERS[2]}.`);
    expect(await describePublic(1, "0xdead", T_USDG, token)).toBe("A vote of kind 1 whose details could not be read.");
  });
});
