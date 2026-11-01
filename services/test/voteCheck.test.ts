import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeAbiParameters, getAddress, type Hex } from "viem";
import { checkBeforeSign, canonicalAction, pageSummary, tokensOf, VOTE_MISMATCH_TEXT } from "../src/core/signCheck";
import { Kind, decodeAction, encodeAction, proposalDigest, typedData, type Action, type ProposalEnvelope } from "../src/core/proposal";

const CHAIN = 4663;
const POT = getAddress("0x00000000000000000000000000000000000000aa");
const USDG = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
const BOB = getAddress("0x00000000000000000000000000000000000000b0");
const EVE = getAddress("0x00000000000000000000000000000000000000e0");
const NOW = 1_800_000_000;

/** What the server sends today: services/proposals.ts serializeTypedData + jsonSafe(decodeAction). */
function serverView(env: ProposalEnvelope) {
  const td = typedData(env);
  const typed = JSON.parse(JSON.stringify(td, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  const action = JSON.parse(JSON.stringify(decodeAction(env.kind, env.data), (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  return { typed, action, id: proposalDigest(env) };
}

function envelopeFor(a: Action, over: Partial<ProposalEnvelope> = {}): ProposalEnvelope {
  const { kind, data } = encodeAction(a);
  return { pot: POT, chainId: CHAIN, kind, data, nonce: 42n, epoch: 3n, deadline: BigInt(NOW + 3600), ...over };
}

const send50: Action = { kind: Kind.TRANSFER, asset: USDG, to: BOB, amount: 50_000_000n };

function run(typed: unknown, action: unknown, id: string, chainId = CHAIN) {
  return checkBeforeSign({ typedData: typed as never, serverAction: action, expectedDigest: id, chainId, nowSec: NOW });
}

describe("signer page vote check (M-2)", () => {
  test("an honest vote passes, and the page signs the envelope it rebuilt", () => {
    const env = envelopeFor(send50);
    const s = serverView(env);
    const r = run(s.typed, s.action, s.id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(proposalDigest(r.envelope)).toBe(s.id);
    expect(canonicalAction(r.action)).toBe(canonicalAction(send50));
  });

  test("the summary shown is built from the signed bytes, with full addresses", () => {
    const r = run(...(Object.values(serverView(envelopeFor(send50))) as [unknown, unknown, string]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(tokensOf(r.action)).toEqual([USDG]);
    expect(pageSummary(r.action, () => ({ symbol: "USDG", decimals: 6 }))).toBe(`Send 50 USDG to ${BOB}`);
  });

  test("server shows one recipient but the bytes pay another: refused", () => {
    const signed = serverView(envelopeFor({ ...send50, to: EVE }));
    const shown = serverView(envelopeFor(send50));
    const r = run(signed.typed, shown.action, signed.id);
    expect(r).toEqual({ ok: false, problem: "server action does not match the signed data" });
  });

  test("server swaps the bytes under the same vote link: refused (digest)", () => {
    const link = serverView(envelopeFor(send50)).id;
    const swapped = serverView(envelopeFor({ ...send50, amount: 5_000_000_000n }));
    expect(run(swapped.typed, swapped.action, link)).toEqual({ ok: false, problem: "digest does not match the vote link" });
  });

  test("wrong chain, wrong domain, wrong types: refused", () => {
    const s = serverView(envelopeFor(send50));
    expect(run(s.typed, s.action, s.id, 46630)).toEqual({ ok: false, problem: "wrong chain" });
    expect(run({ ...s.typed, domain: { ...s.typed.domain, name: "Cofer2" } }, s.action, s.id).ok).toBe(false);
    expect(run({ ...s.typed, domain: { ...s.typed.domain, version: "2" } }, s.action, s.id).ok).toBe(false);
    expect(run({ ...s.typed, primaryType: "Other" }, s.action, s.id)).toEqual({ ok: false, problem: "wrong typed-data types" });
  });

  test("an expired vote is refused before signing", () => {
    const s = serverView(envelopeFor(send50, { deadline: BigInt(NOW) }));
    expect(run(s.typed, s.action, s.id)).toEqual({ ok: false, problem: "vote has expired" });
  });

  test("bytes that decode but are not the canonical encoding are refused", () => {
    const env = envelopeFor(send50);
    const padded = { ...env, data: (env.data + "00".repeat(32)) as Hex };
    const s = serverView(padded);
    expect(run(s.typed, s.action, s.id)).toEqual({ ok: false, problem: "data is not the canonical encoding" });
  });

  test("bytes that do not decode are refused", () => {
    const env = { ...envelopeFor(send50), data: encodeAbiParameters([{ type: "uint8" }], [1]) };
    const typed = JSON.parse(JSON.stringify(typedData(env), (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    expect(run(typed, {}, proposalDigest(env))).toEqual({ ok: false, problem: "data does not decode" });
  });

  test("a swap and a settings change pass when honest", () => {
    const swap: Action = { kind: Kind.SWAP, adapter: EVE, tokenIn: USDG, tokenOut: BOB, amountIn: 10n ** 8n, minOut: 10n ** 15n, route: "0x1234" };
    const s1 = serverView(envelopeFor(swap));
    expect(run(s1.typed, s1.action, s1.id).ok).toBe(true);
    const cfg: Action = { kind: Kind.SET_CONFIG, guardDelay: 21_600, maxSlipBps: 300, entrySpreadBps: 50, depositsOpen: true };
    const s2 = serverView(envelopeFor(cfg));
    expect(run(s2.typed, s2.action, s2.id).ok).toBe(true);
  });

  test("the refusal text is fixed and says nothing was signed", () => {
    expect(VOTE_MISMATCH_TEXT).toContain("Nothing was signed");
  });

  test("the page checks the vote and the pot before the passkey, and signs only its own typed data", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "web", "client.ts"), "utf8");
    const verify = src.indexOf("async function verifyVote");
    expect(verify).toBeGreaterThan(0);
    const body = src.slice(verify, src.indexOf("\n}\n", verify));
    expect(body.indexOf("checkBeforeSign(")).toBeLessThan(body.indexOf('functionName: "isPot"'));
    expect(src).toContain("s.signTypedData(typedData(envelope))");
    expect(src).not.toContain("reviveTypedData");
    expect(src).not.toMatch(/signTypedData\([^)]*p\.typedData/);
    // the approve step only exists after verifyVote succeeded
    expect(src.indexOf("act.onclick = approve(v.envelope)")).toBeGreaterThan(src.indexOf("await verifyVote("));
  });
});

