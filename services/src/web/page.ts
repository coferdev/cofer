/** Minimal server-rendered shell for the signer site. All logic lives in client.ts. */

import { createHash } from "node:crypto";
import { CONFIG_ELEMENT_ID, configJson } from "./pageConfig";
import { EXIT_CONFIRM_TEXT, EXIT_NETWORK_WARNING, EXIT_SET_ASIDE_NOTE, EXIT_TOGGLE_TEXT } from "../core/exitDestination";
import { PASSKEY_LOSS_WARNING } from "../core/passkeyWarning";
import { SIGNUP_CHOICE, WALLET_SEAT_NOTE } from "../core/signupText";

export interface PageCfg {
  chainId: number;
  rpcUrl: string;
  bundlerUrl: string;
  paymasterUrl: string;
  passkeyServerUrl: string;
  usdg: string;
  /** CoferFactory address: the page checks on-chain that a vote is for a real pot (isPot). Without it, votes are refused. */
  factory?: string;
  /** The swap adapter (public): an exit may never be sent to it, also while it is still queued on-chain. */
  adapter?: string;
  /** "passkey" for /s/:token (default), "wallet" for /w/:token */
  mode?: "passkey" | "wallet";
  /** Connect wallet is set up on this server (REOWN_PROJECT_ID and the wallet bundle) */
  walletOn?: boolean;
  /** the public Reown project ID; sent on the wallet page only */
  reownProjectId?: string;
  /** the wallet file's path; sent on the wallet page only */
  walletJs?: "/assets/wallet.js";
}

/**
 * The page's only <style> block. The CSP allows exactly this text by its sha256 hash.
 * The look follows the Cofer website: Geist and Geist Mono (served from this server, /assets/fonts),
 * a black panel on grey, light pill buttons, small mono labels, monochrome. One fixed look (the site
 * has no light/dark switch). Fonts load from 'self', so the passkey page's policy is unchanged.
 */
export const PAGE_CSS = `@font-face{font-family:Geist;src:url(/assets/fonts/geist.woff2) format("woff2");font-weight:100 900;font-display:swap}
@font-face{font-family:"Geist Mono";src:url(/assets/fonts/geist-mono.woff2) format("woff2");font-weight:100 900;font-display:swap}
:root{--page:#858584;--card:#080808;--line:#2e2e31;--panel:#1b1b1e;--field:#1d1d20;--fg:#eeeeec;--soft:#c9c9c6;--muted:#9b9b9f;--btn:#e4e4e1;--btn-fg:#111;--alert:#ffa7a7}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:var(--page);color:var(--fg);font:15px/1.55 Geist,Arial,sans-serif;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%}
main{max-width:480px;margin:0 auto;padding:40px 16px 40px}
.card{background:var(--card);border:1px solid var(--line);border-radius:28px;padding:28px 24px 26px}
.brand{display:flex;align-items:center;gap:8px;margin:0 0 22px;font:600 11px/1 "Geist Mono",monospace;letter-spacing:.14em;color:var(--muted)}
.brand::before{content:"";width:8px;height:8px;background:var(--fg)}
h1{font-size:26px;font-weight:600;letter-spacing:-.035em;line-height:1.15;margin:0 0 10px}
#body{white-space:pre-line;color:var(--muted);font-size:14px;line-height:1.6;margin:0}
input{width:100%;padding:12px 14px;margin:12px 0 0;border-radius:12px;border:1px solid #4a4a4d;background:var(--field);color:var(--fg);font:15px Geist,Arial,sans-serif}
input::placeholder{color:#7d7d82}
input:focus{outline:2px solid var(--fg);outline-offset:1px}
button{width:100%;min-height:48px;padding:12px 18px;border:1px solid var(--btn);border-radius:999px;background:var(--btn);color:var(--btn-fg);font:500 15px Geist,Arial,sans-serif;margin-top:16px;cursor:pointer;transition:background .15s,opacity .15s}
button:hover{background:#fff}
button:disabled{opacity:.45;cursor:default}
button:focus-visible{outline:2px solid var(--fg);outline-offset:3px}
#status{margin:16px 0 0;font-size:14px;color:var(--soft);white-space:pre-line;overflow-wrap:anywhere}
#status:empty{display:none}
#status[data-tone]{padding:12px 14px;border-radius:14px;background:var(--panel);border:1px solid var(--line);color:var(--fg)}
#status[data-tone=error]{border-left:3px solid var(--alert)}
#status[data-tone=ok]{border-left:3px solid var(--fg)}
small{color:var(--muted)}
.check{width:auto;margin:0 6px 0 0;accent-color:var(--btn);vertical-align:-2px}
label small{color:var(--soft)}
.foot{margin:16px 8px 0;font-size:12px;line-height:1.55;color:#1c1c1c}
.foot small{color:inherit}
#notice{position:fixed;inset:0;background:rgba(0,0,0,.62);display:flex;align-items:center;justify-content:center;padding:16px;z-index:10}
#notice[hidden]{display:none}
#notice .card{max-width:400px;box-shadow:0 16px 60px rgba(0,0,0,.5)}
#notice h1{font-size:22px}
#notice p{color:var(--muted);font-size:14px;margin:0}
.warn{color:var(--soft);font-size:13px;line-height:1.55;margin:12px 2px 0;padding:0 0 0 12px;border-left:2px solid #8a8a8e}
details{margin:16px 0 0;padding:14px 16px;border:1px solid var(--line);border-radius:16px;background:var(--panel)}
summary{cursor:pointer;color:var(--fg);font-weight:500}
.addr{font:13px/1.5 "Geist Mono",monospace;color:var(--soft);overflow-wrap:anywhere;margin:8px 0 0}
#choice{margin:22px 0 0;font-size:14px;font-weight:600;color:var(--fg)}
.or{display:flex;align-items:center;gap:12px;color:var(--muted);font:11px "Geist Mono",monospace;letter-spacing:.12em;text-transform:uppercase;margin:18px 0 2px}
.or::before,.or::after{content:"";flex:1;border-top:1px dashed #3d3d40}
.or[hidden]{display:none}
@media (max-width:480px){main{padding:16px 10px 28px}.card{border-radius:22px;padding:22px 18px 20px}h1{font-size:23px}.brand{margin-bottom:18px}}`;

const styleHash = createHash("sha256").update(PAGE_CSS, "utf8").digest("base64");

/** Only /assets/signer.js runs: no inline script is allowed (settings travel in a JSON data block). */
export const SIGNER_CSP = `default-src 'self'; script-src 'self'; style-src 'sha256-${styleHash}'; connect-src *; frame-ancestors 'none'`;

/**
 * The wallet page only (/w/:token): the passkey page keeps SIGNER_CSP unchanged. Scripts are still
 * only the site's own files (signer.js, wallet.js). Opened only as far as the wallet window needs:
 *  - style-src 'unsafe-inline': AppKit writes its theme into <style> tags at run time (no fixed hash);
 *  - img-src: wallet logos from Reown's wallet registry (EIP-6963 wallets bring their own data: icons);
 *  - font-src 'self': the window uses the page's own self-hosted Geist (no font from Reown);
 *  - connect-src wss:: the WalletConnect relay (spelled out, as some browsers do not match ws by "*");
 *  - frame-src: WalletConnect's domain check (Verify) runs in a hidden frame.
 */
export const WALLET_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://api.web3modal.org https://*.walletconnect.com https://*.walletconnect.org https://*.reown.com",
  "font-src 'self'",
  "connect-src * wss:",
  "frame-src https://verify.walletconnect.org https://verify.walletconnect.com",
  "frame-ancestors 'none'",
].join("; ");

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

/**
 * The page shell, for both pages. #walletBtn (hidden until the page picks it, core/keyChoice.ts) is
 * Connect wallet: on the passkey page only at sign-up (it opens the wallet page; shown first, above
 * "or" and the passkey button), on the wallet page for every action. A passkey member never sees it.
 */
export function signerPage(token: string, cfg: PageCfg): string {
  const boot = configJson({ ...cfg, token });
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Cofer signer</title>
<style>${PAGE_CSS}</style></head>
<body><main><div class="card">
<p class="brand">COFER</p>
<h1 id="title">Loading...</h1>
<p id="body"></p>
<details id="dest" hidden><summary>${esc(EXIT_TOGGLE_TEXT)}</summary>
<p class="warn">${esc(EXIT_NETWORK_WARNING)}</p>
<input id="destAddr" placeholder="Destination 0x..." autocomplete="off" autocapitalize="off" spellcheck="false">
<p id="destShow" class="addr"></p>
<p><small>${esc(EXIT_SET_ASIDE_NOTE)}</small></p>
<p class="warn">${esc(EXIT_NETWORK_WARNING)}</p>
<label><input type="checkbox" id="destOk" class="check"> <small>${esc(EXIT_CONFIRM_TEXT)}</small></label>
</details>
<input id="amount" inputmode="decimal" placeholder="Amount (USDG)" hidden>
<input id="to" placeholder="Recipient 0x..." hidden>
<p id="choice" hidden>${esc(SIGNUP_CHOICE)}</p>
<div id="wallet"><button id="walletBtn" hidden>Connect wallet</button><p id="walletNote" class="warn" hidden>${esc(WALLET_SEAT_NOTE)}</p><p id="walletAddr" class="addr" hidden></p></div>
<p id="or" class="or" hidden>or</p>
<button id="action">...</button>
<p id="keywarn" class="warn" hidden>${esc(PASSKEY_LOSS_WARNING)}</p>
<p id="status"></p>
</div>
<p class="foot" id="foot"><small>Votes count only when signed with your own key. Exiting with your exact share is always available.</small></p>
</main>
<div id="notice" role="dialog" aria-modal="true" aria-labelledby="notice-title" hidden><div class="card">
<h1 id="notice-title">Open in your browser (recommended)</h1>
<p>For your passkey (Face ID or fingerprint) to work, open this page in your phone's browser. In Telegram, tap ••• and choose Open in browser (on iPhone: Open in Safari).</p>
<button id="notice-ok">Got it</button>
</div></div>
<script type="application/json" id="${CONFIG_ELEMENT_ID}">${boot}</script>
<script type="module" src="/assets/signer.js"></script>
</body></html>`;
}

export { esc };
