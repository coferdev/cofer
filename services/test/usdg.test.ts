import { describe, expect, test } from "bun:test";
import type { Address } from "viem";
import { parseEnv } from "../src/env";
import { RHC } from "../src/chain/addresses";
import { assertFactoryUsdg } from "../src/chain/clients";
import { signerPage } from "../src/web/page";

const base = {
  PUBLIC_URL: "https://sign.example.com",
  DATABASE_URL: "postgres://localhost/cofer",
  RHC_RPC_URL: "http://127.0.0.1:8545",
  FACTORY_ADDRESS: "0x1111111111111111111111111111111111111111",
  ADAPTER_ADDRESS: "0x2222222222222222222222222222222222222222",
  RELAYER_PRIVATE_KEY: "0x01",
  TELEGRAM_BOT_TOKEN: "t",
  TELEGRAM_BOT_USERNAME: "CoferBot",
  TELEGRAM_WEBHOOK_SECRET: "s".repeat(16),
  LINK_SECRET: "l".repeat(32),
};
const MOCK = "0x3333333333333333333333333333333333333333" as Address;
const FACTORY = base.FACTORY_ADDRESS as Address;
const fakeClient = (usdg: string) => ({ readContract: async () => usdg }) as never;

describe("configured USDG", () => {
  test("defaults to mainnet USDG and accepts an override", () => {
    expect(parseEnv(base).USDG_ADDRESS).toBe(RHC.USDG);
    expect(parseEnv({ ...base, USDG_ADDRESS: MOCK }).USDG_ADDRESS).toBe(MOCK);
  });

  test("rejects a malformed address", () => {
    expect(() => parseEnv({ ...base, USDG_ADDRESS: "0x1234" })).toThrow();
  });

  test("startup check passes on a match, ignoring letter case", async () => {
    await assertFactoryUsdg(fakeClient(RHC.USDG.toLowerCase()), FACTORY, RHC.USDG);
  });

  test("startup check refuses a mismatch with a clear message", async () => {
    await expect(assertFactoryUsdg(fakeClient(MOCK), FACTORY, RHC.USDG)).rejects.toThrow(/USDG mismatch.*Set USDG_ADDRESS/);
  });

  test("signer page carries the configured USDG", () => {
    const html = signerPage("tok", { chainId: 46630, rpcUrl: "", bundlerUrl: "", paymasterUrl: "", passkeyServerUrl: "", usdg: MOCK });
    expect(html).toContain(`"usdg":"${MOCK}"`);
    expect(html).not.toContain(RHC.USDG);
  });
});
