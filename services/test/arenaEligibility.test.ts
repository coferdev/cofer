import { describe, expect, test } from "bun:test";
import { type Hex, decodeAbiParameters, keccak256, recoverAddress, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arenaGate } from "../src/core/geo";
import { type EligibilityAsk, ELIGIBILITY_TTL_S, decide, eligibilityDigest, issue } from "../src/arena/eligibility/signer";

const NOW = Date.parse("2026-11-25T12:00:00Z");
const ask = (x: Partial<EligibilityAsk> = {}): EligibilityAsk => ({
  chainId: 4663, table: "0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f", mode: "FREEROLL", hasStocks: false,
  player: "0x00000000000000000000000000000000000000b1", telegramId: "111", credentialId: "cred-1",
  declared: "DE", ipCountry: "DE", asnClass: "residential", accountCreatedAt: NOW - 100 * 3_600_000, practiceGamesFinished: 1,
  seated: [], now: NOW, ...x,
});

describe("arena eligibility", () => {
  test("the digest is the escrow's (fixed vector in contracts/test/arena/EligibilityDigestVector.t.sol)", () => {
    expect(eligibilityDigest(4663, "0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f", "0x00000000000000000000000000000000000A11cE", "FREEROLL", true, 1_800_000_540n))
      .toBe("0x2581b43e37af149227f1385854a9c288d5bf16ccfc07e6288b8a8a672aeeb05b");
  });

  test("the region gate: sanctioned never plays, Friend Tables blocked by region, network and mismatch, Practice always", () => {
    expect(arenaGate("PRACTICE", false, { declared: "IR" })).toEqual({ play: false, prize: false, reason: "region" });
    expect(arenaGate("PRACTICE", true, { declared: "US", ipCountry: "US" })).toEqual({ play: true, prize: false });
    expect(arenaGate("FRIEND", false, { declared: "US" }).reason).toBe("region");
    expect(arenaGate("FRIEND", false, { declared: "DE", ipCountry: "SG" }).reason).toBe("region");
    expect(arenaGate("FRIEND", false, { declared: "DE", asnClass: "vpn" }).reason).toBe("network");
    expect(arenaGate("FRIEND", false, { declared: "DE", ipCountry: "FR" }).reason).toBe("mismatch");
    expect(arenaGate("FRIEND", false, { declared: "DE", ipCountry: "DE" })).toEqual({ play: true, prize: true });
    expect(arenaGate("FRIEND", false, {}).play).toBe(false);
    expect(arenaGate("FREEROLL", false, {})).toEqual({ play: true, prize: false, reason: "declare-region" });
    expect(arenaGate("FREEROLL", true, { declared: "GB" })).toEqual({ play: true, prize: false, reason: "region" });
    expect(arenaGate("FREEROLL", false, { declared: "GB" })).toEqual({ play: true, prize: true });
    expect(arenaGate("FREEROLL", false, { declared: "DE", asnClass: "hosting" }).prize).toBe(false);
  });

  test("one seat per smart account, Telegram account and passkey; group tables need chat membership", () => {
    const s = { player: "0x00000000000000000000000000000000000000B1", telegramId: "999", credentialId: "x" };
    expect(decide(ask({ seated: [s] }))).toMatchObject({ ok: false, refusal: "seated" });
    expect(decide(ask({ seated: [{ ...s, player: "0xc1", telegramId: "111" }] }))).toMatchObject({ ok: false, refusal: "telegram-seated" });
    expect(decide(ask({ seated: [{ ...s, player: "0xc1", credentialId: "cred-1" }] }))).toMatchObject({ ok: false, refusal: "credential-seated" });
    expect(decide(ask({ chatMember: false }))).toMatchObject({ ok: false, refusal: "not-in-chat" });
    expect(decide(ask({ chatMember: true })).ok).toBe(true);
    expect(decide(ask({ declared: "UA", ipCountry: "UA", ipRegion: "UA-43" }))).toMatchObject({ ok: false, refusal: "region" });
    expect(decide(ask({ mode: "FRIEND", asnClass: "vpn" }))).toMatchObject({ ok: false, refusal: "network" });
  });

  test("Freeroll prizes need a 72 h old account, one Practice game and no cluster flag; the seat is still given", () => {
    expect(decide(ask())).toMatchObject({ ok: true, prizeEligible: true });
    expect(decide(ask({ accountCreatedAt: NOW - 71 * 3_600_000 }))).toMatchObject({ ok: true, prizeEligible: false, prizeReason: "account-age" });
    expect(decide(ask({ practiceGamesFinished: 0 }))).toMatchObject({ ok: true, prizeEligible: false, prizeReason: "no-practice" });
    expect(decide(ask({ clusterFlag: true }))).toMatchObject({ ok: true, prizeEligible: false, prizeReason: "cluster" });
    expect(decide(ask({ mode: "FRIEND", accountCreatedAt: NOW, practiceGamesFinished: 0 }))).toMatchObject({ ok: true, prizeEligible: true });
    expect(decide(ask({ mode: "FRIEND", ipCountry: "US" }))).toMatchObject({ ok: false, refusal: "region" });
  });

  test("issue signs the escrow's digest and packs (prizeEligible, expiry, sig), expiring inside the escrow's 10 minutes", async () => {
    const key = privateKeyToAccount(keccak256(toHex("arena eligibility test key"))); // made up for this test
    const q = ask();
    const out = await issue(q, (d) => key.sign({ hash: d }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.expiry - Math.floor(NOW / 1000)).toBe(ELIGIBILITY_TTL_S);
    expect(ELIGIBILITY_TTL_S).toBeLessThan(600);
    const [pe, exp, sig] = decodeAbiParameters([{ type: "bool" }, { type: "uint64" }, { type: "bytes" }], out.eligibility);
    expect(pe).toBe(true);
    const who = await recoverAddress({ hash: eligibilityDigest(4663, q.table, q.player, "FREEROLL", pe, exp), signature: sig as Hex });
    expect(who).toBe(key.address);
    let called = false;
    const refused = await issue(ask({ declared: "KP" }), async () => ((called = true), "0x"));
    expect(refused).toMatchObject({ ok: false, refusal: "region" });
    expect(called).toBe(false);
  });
});
