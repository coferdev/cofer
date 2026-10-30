import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { signerPage, SIGNER_CSP } from "../src/web/page";

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
