import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PUBLIC_RPC, signerPage, signerRpcUrl, SIGNER_CSP } from "../src/web/page";

describe("signer page content-security-policy", () => {
  const html = signerPage("tok", { chainId: 46630, rpcUrl: "https://rpc.example", bundlerUrl: "", paymasterUrl: "", passkeyServerUrl: "", usdg: "0x0000000000000000000000000000000000000001" });

  test("style-src hash matches the page's only <style> block", () => {
    const blocks = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)];
    expect(blocks.length).toBe(1);
    const hash = createHash("sha256").update(blocks[0]![1]!, "utf8").digest("base64");
    expect(SIGNER_CSP).toContain(`style-src 'sha256-${hash}';`);
  });

  test("styles are not opened up with 'unsafe-inline' and no inline style attributes remain", () => {
    const styleSrc = SIGNER_CSP.split(";").map((d) => d.trim()).find((d) => d.startsWith("style-src"));
    expect(styleSrc).not.toContain("unsafe-inline");
    expect(html).not.toMatch(/\sstyle=/);
  });

  test("the amount and recipient boxes start hidden (the page shows them only where needed)", () => {
    expect(html).toMatch(/<input id="amount"[^>]* hidden>/);
    expect(html).toMatch(/<input id="to"[^>]* hidden>/);
  });

  test("the rest of the policy is unchanged", () => {
    const rest = SIGNER_CSP.split(";").map((d) => d.trim()).filter((d) => !d.startsWith("style-src"));
    expect(rest).toEqual(["default-src 'self'", "script-src 'self' 'unsafe-inline'", "connect-src *", "frame-ancestors 'none'"]);
  });
});

describe("signer page RPC", () => {
  const KEYED = "https://api-robinhood-mainnet-archive.n.dwellir.com/SECRETKEY123";
  const page = (rpcUrl: string) =>
    signerPage("tok", { chainId: 4663, rpcUrl, bundlerUrl: "", paymasterUrl: "", passkeyServerUrl: "", usdg: "0x0000000000000000000000000000000000000001" });

  test("the server's keyed RHC_RPC_URL never reaches the page; the public RPC is used by default", () => {
    const url = signerRpcUrl({ CHAIN_ID: 4663, RHC_RPC_URL: KEYED });
    expect(url).toBe(PUBLIC_RPC[4663]!);
    expect(page(url)).not.toContain("SECRETKEY123");
    expect(signerRpcUrl({ CHAIN_ID: 46630, RHC_RPC_URL: KEYED })).toBe("https://rpc.testnet.chain.robinhood.com");
  });

  test("SIGNER_RPC_URL is used when set", () => {
    expect(signerRpcUrl({ CHAIN_ID: 4663, RHC_RPC_URL: KEYED, SIGNER_RPC_URL: "https://browser-rpc.example" })).toBe("https://browser-rpc.example");
  });

  test("refuses to reuse a non-public server RPC for the browser, and an unknown chain without a setting", () => {
    expect(() => signerRpcUrl({ CHAIN_ID: 4663, RHC_RPC_URL: KEYED, SIGNER_RPC_URL: KEYED })).toThrow();
    expect(() => signerRpcUrl({ CHAIN_ID: 1, RHC_RPC_URL: KEYED })).toThrow();
    // a public RPC used for both is fine (testnet setups)
    const pub = PUBLIC_RPC[46630]!;
    expect(signerRpcUrl({ CHAIN_ID: 46630, RHC_RPC_URL: pub, SIGNER_RPC_URL: pub })).toBe(pub);
  });

  test("the server never passes RHC_RPC_URL into the page", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "api", "server.ts"), "utf8");
    expect(src).not.toMatch(/rpcUrl:\s*e\.RHC_RPC_URL/);
    expect(src).toContain("signerRpcUrl(e)");
  });
});
