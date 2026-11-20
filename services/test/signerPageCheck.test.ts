import { describe, expect, test } from "bun:test";
import { sha256, signerCheck, signerPageProblem, TEST_TOKEN, type SignerCheckDeps } from "../src/keeper/signerCheck";
import type { AlertDeps } from "../src/keeper/alerts";

const SIGNER_JS = "console.log('signer')";
const WALLET_JS = "console.log('wallet')";
type Page = { status?: number; csp?: string | null; xfo?: string | null; body?: string };

function site(over: { s?: Page; w?: Page; signerJs?: string | null; walletJs?: string | null; down?: boolean } = {}, walletOn = true) {
  const page = (p: Page | undefined, csp: string, body: string) => new Response(p?.body ?? body, { status: p?.status ?? 200, headers: Object.fromEntries(Object.entries({ "content-security-policy": p?.csp === undefined ? csp : p.csp, "x-frame-options": p?.xfo === undefined ? "DENY" : p.xfo }).filter(([, v]) => v !== null)) as Record<string, string> });
  const f = (async (url: string | URL | Request) => {
    if (over.down) throw new Error("connection refused");
    const path = new URL(String(url)).pathname;
    if (path === `/s/${TEST_TOKEN}`) return page(over.s, "PASSKEY-CSP", '<script type="module" src="/assets/signer.js"></script>');
    if (path === `/w/${TEST_TOKEN}`) return page(over.w, walletOn ? "WALLET-CSP" : "PASSKEY-CSP", `<script type="application/json">{"walletJs":"/assets/wallet.js"}</script><script type="module" src="/assets/signer.js"></script>`);
    if (path === "/assets/signer.js") return over.signerJs === null ? new Response("no", { status: 404 }) : new Response(over.signerJs ?? SIGNER_JS);
    if (path === "/assets/wallet.js") return over.walletJs === null ? new Response("no", { status: 404 }) : new Response(over.walletJs ?? WALLET_JS);
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  const open = new Map<string, string>();
  const sent: string[] = [];
  const alerts: AlertDeps = { open: async (k, t) => (open.has(k) ? false : (open.set(k, t), true)), close: async (k) => { const t = open.get(k) ?? null; open.delete(k); return t; }, send: async (t) => void sent.push(t) };
  const deps: SignerCheckDeps = { baseUrl: "https://sign.example", fetch: f, passkeyCsp: "PASSKEY-CSP", walletCsp: walletOn ? "WALLET-CSP" : null, expected: async () => ({ signer: sha256(SIGNER_JS), wallet: sha256(WALLET_JS) }), alerts };
  return { deps, open, sent };
}

describe("signing page check", () => {
  test("both pages as they should be: no problem", async () => {
    expect(await signerPageProblem(site().deps)).toBeNull();
    expect(await signerPageProblem(site({}, false).deps)).toBeNull();
  });

  test("each failure kind is named", async () => {
    const cases: [Parameters<typeof site>[0], string][] = [
      [{ down: true }, "The passkey page did not answer."],
      [{ s: { status: 502 } }, "The passkey page answered 502."],
      [{ s: { csp: "default-src *" } }, "The passkey page is served without its exact security policy."],
      [{ w: { csp: null } }, "The wallet page is served without its exact security policy."],
      [{ s: { xfo: null } }, "The passkey page can be framed by another site (x-frame-options is not DENY)."],
      [{ s: { body: "<html></html>" } }, "The passkey page does not load /assets/signer.js."],
      [{ w: { body: '<script type="module" src="/assets/signer.js"></script>' } }, "The wallet page does not load /assets/wallet.js while Connect wallet is on."],
      [{ signerJs: null }, "/assets/signer.js did not load (404)."],
      [{ signerJs: "console.log('changed')" }, "/assets/signer.js is not the script this release builds (its SHA-256 differs)."],
      [{ walletJs: "console.log('changed')" }, "/assets/wallet.js is not the script this release builds (its SHA-256 differs)."],
    ];
    for (const [over, why] of cases) expect(await signerPageProblem(site(over).deps)).toBe(why);
  });

  test("the alert opens once with the reason and clears when the pages are right again", async () => {
    const bad = site({ signerJs: "x" });
    expect(await signerCheck(bad.deps)).toBe("opened");
    expect(await signerCheck(bad.deps)).toBeNull();
    expect(bad.sent[0]).toContain("signer-page-down");
    const good = site();
    Object.assign(good.deps.alerts, bad.deps.alerts);
    expect(await signerCheck({ ...good.deps, alerts: bad.deps.alerts })).toBe("cleared");
  });
});
