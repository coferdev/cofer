import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PUBLIC_RPC, signerPage, signerRpcUrl, SIGNER_CSP } from "../src/web/page";
import { CONFIG_ELEMENT_ID, configJson } from "../src/web/pageConfig";

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

  test("the rest of the policy: scripts only from the site itself, never inline (I-6)", () => {
    const rest = SIGNER_CSP.split(";").map((d) => d.trim()).filter((d) => !d.startsWith("style-src"));
    expect(rest).toEqual(["default-src 'self'", "script-src 'self'", "connect-src *", "frame-ancestors 'none'"]);
    expect(SIGNER_CSP).not.toContain("unsafe-inline");
  });

  test("the page has no inline script that runs: only the bundle and a JSON data block", () => {
    const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)].map((m) => ({ attrs: m[1]!, body: m[2]! }));
    expect(scripts).toHaveLength(2);
    for (const s of scripts) {
      const external = /\ssrc="\/assets\/signer\.js"/.test(s.attrs) && s.body === "";
      const data = /\stype="application\/json"/.test(s.attrs) && new RegExp(`\\sid="${CONFIG_ELEMENT_ID}"`).test(s.attrs);
      expect(external || data).toBe(true);
    }
    expect(html).not.toContain("window.COFER");
    expect(html).not.toMatch(/\son[a-z]+=/i); // no inline event handlers either
  });

  test("the settings block parses back, and text in it cannot close the block", () => {
    const evil = signerPage("</script><script>alert(1)</script>", { chainId: 46630, rpcUrl: "https://rpc.example", bundlerUrl: "", paymasterUrl: "", passkeyServerUrl: "", usdg: "0x0000000000000000000000000000000000000001", factory: "0x0000000000000000000000000000000000000002" });
    const block = new RegExp(`<script type="application/json" id="${CONFIG_ELEMENT_ID}">([\\s\\S]*?)</script>`).exec(evil)![1]!;
    expect(block).not.toContain("<");
    const cfg = JSON.parse(block);
    expect(cfg.token).toBe("</script><script>alert(1)</script>");
    expect(cfg.factory).toBe("0x0000000000000000000000000000000000000002");
  });

  test("the phone notice now lives in the bundle, and the bundle reads the data block", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "web", "client.ts"), "utf8");
    expect(src).toContain("JSON.parse(document.getElementById(CONFIG_ELEMENT_ID)!.textContent!)");
    expect(src).toContain('document.getElementById("notice-ok")');
    expect(configJson("<")).toBe('"\\u003c"');
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
