import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HttpRequestError, type Address, type Hex } from "viem";
import { ProposalError, refuseWithdrawnVote, VOTE_WITHDRAWN_TEXT } from "../src/services/proposals";

const POT = "0x2D3365a056074f6cd35C943EDcE644FAE7Eb8A45" as Address;
const SIGNER = "0x00000000000000000000000000000000000B0b00" as Address;
const DIGEST = `0x${"ab".repeat(32)}` as Hex;

/** A chain where pot.revoked(digest, signer) is `withdrawn`; records what was asked. */
function chain(withdrawn: boolean | "fail") {
  const calls: { address: string; functionName: string; args: readonly unknown[] }[] = [];
  return {
    calls,
    client: {
      readContract: (async (a: { address: string; functionName: string; args: readonly unknown[] }) => {
        calls.push(a);
        if (withdrawn === "fail") throw new HttpRequestError({ url: "https://rpc.example/KEY", details: "fetch failed" });
        return withdrawn;
      }) as never,
    },
  };
}

describe("audit v2 L-1: a vote withdrawn on the contract never counts again", () => {
  test("withdrawn on-chain: the signature is refused with fixed text", async () => {
    const c = chain(true);
    const err = await refuseWithdrawnVote(c.client, POT, DIGEST, SIGNER).catch((e) => e);
    expect(err).toBeInstanceOf(ProposalError);
    expect(err.message).toBe(VOTE_WITHDRAWN_TEXT);
  });

  test("it asks the pot itself, for this proposal and this signer", async () => {
    const c = chain(false);
    await refuseWithdrawnVote(c.client, POT, DIGEST, SIGNER);
    expect(c.calls).toEqual([expect.objectContaining({ address: POT, functionName: "revoked", args: [DIGEST, SIGNER] })]);
  });

  test("not withdrawn: the signature goes ahead", async () => {
    expect(await refuseWithdrawnVote(chain(false).client, POT, DIGEST, SIGNER)).toBeUndefined();
  });

  test("the chain cannot be read: the signature is not accepted (the error is passed on, never counted blindly)", async () => {
    const err = await refuseWithdrawnVote(chain("fail").client, POT, DIGEST, SIGNER).catch((e) => e);
    expect(err).toBeInstanceOf(HttpRequestError);
    expect(err).not.toBeInstanceOf(ProposalError);
  });

  test("the text tells the member what to do", () => {
    expect(VOTE_WITHDRAWN_TEXT).toContain("can't count again");
    expect(VOTE_WITHDRAWN_TEXT).toContain("new proposal");
  });

  test("addSignature checks it before the signature is saved or counted", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "services", "proposals.ts"), "utf8");
    const fn = src.slice(src.indexOf("export async function addSignature"), src.indexOf("export async function buildExecuteArgs"));
    const check = fn.indexOf("await refuseWithdrawnVote(client, env.pot, args.id, signer)");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(fn.indexOf(".insert(schema.signatures)"));
    expect(check).toBeLessThan(fn.indexOf("tally("));
  });
});
