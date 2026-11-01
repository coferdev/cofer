/** Minimal server-rendered shell for the signer site. All logic lives in client.ts. */

import { createHash } from "node:crypto";

export interface PageCfg {
  chainId: number;
  rpcUrl: string;
  bundlerUrl: string;
  paymasterUrl: string;
  passkeyServerUrl: string;
  usdg: string;
  /** CoferFactory address: the page checks on-chain that a vote is for a real pot (isPot). Without it, votes are refused. */
  factory?: string;
}

/** The page's only <style> block. The CSP allows exactly this text by its sha256 hash. */
export const PAGE_CSS = `:root{--bg:#f7f5f0;--fg:#1c1b19;--muted:#6b675f;--accent:#2f5d50;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#141412;--fg:#ecebe6;--muted:#a19d94;--accent:#7fb7a4;--card:#1e1d1b}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:440px;margin:0 auto;padding:24px 16px}
.card{background:var(--card);border-radius:14px;padding:20px}
h1{font-size:20px;margin:0 0 8px}#body{white-space:pre-line;color:var(--muted)}
input{width:100%;box-sizing:border-box;padding:10px;margin:8px 0;border-radius:8px;border:1px solid var(--muted);background:transparent;color:var(--fg)}
button{width:100%;padding:12px;border:0;border-radius:10px;background:var(--accent);color:#fff;font-weight:600;margin-top:12px}
#status{margin-top:12px;color:var(--muted);word-break:break-all}
small{color:var(--muted)}
.check{width:auto}
#notice{position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:16px;z-index:10}
#notice[hidden]{display:none}
#notice .card{max-width:400px;box-shadow:0 8px 32px rgba(0,0,0,.3)}
#notice p{color:var(--muted);margin:0}`;

const styleHash = createHash("sha256").update(PAGE_CSS, "utf8").digest("base64");

export const SIGNER_CSP = `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'sha256-${styleHash}'; connect-src *; frame-ancestors 'none'`;

const esc = (s: string) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Public chain RPCs (no key). The only kind of RPC address the page gets by default. */
export const PUBLIC_RPC: Record<number, string> = {
  4663: "https://rpc.mainnet.chain.robinhood.com",
  46630: "https://rpc.testnet.chain.robinhood.com",
};

/**
 * The RPC the browser uses: SIGNER_RPC_URL if set, else the chain's public RPC. Never the server's
 * RHC_RPC_URL, which can carry a paid API key: everything in the page is readable by every member.
 * Runs once at startup, so a bad setting stops the server instead of serving a page.
 */
export function signerRpcUrl(e: { CHAIN_ID: number; RHC_RPC_URL: string; SIGNER_RPC_URL?: string }): string {
  const url = e.SIGNER_RPC_URL ?? PUBLIC_RPC[e.CHAIN_ID];
  if (!url) throw new Error(`no public RPC known for chain ${e.CHAIN_ID}; set SIGNER_RPC_URL`);
  const isPublic = Object.values(PUBLIC_RPC).includes(url);
  if (url === e.RHC_RPC_URL && !isPublic) throw new Error("SIGNER_RPC_URL must not be the server's RHC_RPC_URL (it is sent to every browser)");
  return url;
}

export function signerPage(token: string, cfg: PageCfg): string {
  const boot = JSON.stringify({ ...cfg, token }).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Cofer signer</title>
<style>${PAGE_CSS}</style></head>
<body><main><div class="card">
<h1 id="title">Loading...</h1>
<p id="body"></p>
<input id="amount" inputmode="decimal" placeholder="Amount (USDG)" hidden>
<input id="to" placeholder="Recipient 0x..." hidden>
<label><input type="checkbox" id="useWallet" class="check"> <small>Use a browser wallet instead of a passkey</small></label>
<button id="action">...</button>
<p id="status"></p>
</div>
<p><small>Votes count only when signed with your own key. Exiting with your exact share is always available.</small></p>
</main>
<div id="notice" role="dialog" aria-modal="true" aria-labelledby="notice-title" hidden><div class="card">
<h1 id="notice-title">Open in your browser (recommended)</h1>
<p>For your passkey (Face ID or fingerprint) to work, open this page in your phone's browser. In Telegram, tap ••• and choose Open in browser (on iPhone: Open in Safari).</p>
<button id="notice-ok">Got it</button>
</div></div>
<script>(function(){
// passkeys do not work in Telegram's in-app browser, so phones get a hint to switch browsers
var n=navigator,phone=/Android|iPhone|iPad|iPod|Mobile/i.test(n.userAgent)||(n.platform==="MacIntel"&&n.maxTouchPoints>1);
if(!phone)return;
var box=document.getElementById("notice"),ok=document.getElementById("notice-ok");
box.hidden=false;ok.focus();
ok.onclick=function(){box.hidden=true};
})();</script>
<script>window.COFER=${boot};</script>
<script type="module" src="/assets/signer.js"></script>
</body></html>`;
}

export { esc };
