/** Minimal server-rendered shell for the signer site. All logic lives in client.ts. */

export interface PageCfg {
  chainId: number;
  rpcUrl: string;
  bundlerUrl: string;
  paymasterUrl: string;
  passkeyServerUrl: string;
  usdg: string;
}

const esc = (s: string) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function signerPage(token: string, cfg: PageCfg): string {
  const boot = JSON.stringify({ ...cfg, token }).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Cofer signer</title>
<style>
:root{--bg:#f7f5f0;--fg:#1c1b19;--muted:#6b675f;--accent:#2f5d50;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#141412;--fg:#ecebe6;--muted:#a19d94;--accent:#7fb7a4;--card:#1e1d1b}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:440px;margin:0 auto;padding:24px 16px}
.card{background:var(--card);border-radius:14px;padding:20px}
h1{font-size:20px;margin:0 0 8px}#body{white-space:pre-line;color:var(--muted)}
input{width:100%;box-sizing:border-box;padding:10px;margin:8px 0;border-radius:8px;border:1px solid var(--muted);background:transparent;color:var(--fg)}
button{width:100%;padding:12px;border:0;border-radius:10px;background:var(--accent);color:#fff;font-weight:600;margin-top:12px}
#status{margin-top:12px;color:var(--muted);word-break:break-all}
small{color:var(--muted)}
</style></head>
<body><main><div class="card">
<h1 id="title">Loading...</h1>
<p id="body"></p>
<input id="amount" inputmode="decimal" placeholder="Amount (USDG)">
<input id="to" placeholder="Recipient 0x... (spend only)">
<label><input type="checkbox" id="useWallet" style="width:auto"> <small>Use a browser wallet instead of a passkey</small></label>
<button id="action">...</button>
<p id="status"></p>
</div>
<p><small>Votes count only when signed with your own key. Exiting with your exact share is always available.</small></p>
</main>
<script>window.COFER=${boot};</script>
<script type="module" src="/assets/signer.js"></script>
</body></html>`;
}

export { esc };
