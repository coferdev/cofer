import { describe, expect, test } from "bun:test";
import { assertChain, chainGuardProblems, chainInUrl } from "../src/core/chainGuard";

const ok = { chainId: 4663, serverRpcChainId: async () => 4663, signerRpcChainId: async () => 4663 };

describe("chain guard at start-up", () => {
  test("everything on CHAIN_ID: starts", async () => {
    expect(await chainGuardProblems({ ...ok, bundlerUrl: "https://rpc.example/api/v3/abc/chain/4663", paymasterUrl: "https://pm.example/v2?chainId=4663" })).toEqual([]);
    await assertChain(ok);
  });

  test("each mismatch stops start-up with a plain sentence and no URL", async () => {
    const cases: [Partial<Parameters<typeof chainGuardProblems>[0]>, string][] = [
      [{ serverRpcChainId: async () => 46630 }, "The server's RPC (RHC_RPC_URL) is on chain 46630, but CHAIN_ID is 4663."],
      [{ signerRpcChainId: async () => 46630 }, "The signer page's RPC is on chain 46630, but CHAIN_ID is 4663."],
      [{ bundlerUrl: "https://rpc.example/api/v3/SECRETKEY/chain/46630" }, "BUNDLER_URL is for chain 46630, but CHAIN_ID is 4663."],
      [{ paymasterUrl: "https://pm.example/rpc?chain_id=46630&apikey=SECRET" }, "PAYMASTER_URL is for chain 46630, but CHAIN_ID is 4663."],
      [{ serverRpcChainId: async () => Promise.reject(new Error("https://key@rpc")) }, "The server's RPC (RHC_RPC_URL) did not answer, so its chain could not be checked."],
    ];
    for (const [over, why] of cases) {
      const e = await assertChain({ ...ok, ...over }).catch((x) => x as Error);
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toBe(`Chain guard: not starting. ${why}`);
      expect((e as Error).message).not.toMatch(/SECRET|https?:/);
    }
  });

  test("chain numbers in provider URLs", () => {
    expect([chainInUrl("https://x/chain/4663"), chainInUrl("https://x/chains/46630/rpc"), chainInUrl("https://x?chainId=4663"), chainInUrl("https://x/v1/rpc"), chainInUrl(undefined)]).toEqual([4663, 46630, 4663, null, null]);
  });
});
