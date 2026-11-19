/**
 * The transaction explainer page, /tx and /tx/<hash>: paste a hash, read what happened in plain words. Rendered on the
 * server; no script at all (its policy allows none), only the site's own fonts. Read-only.
 */
import type { Explanation } from "../core/txExplain";

export const TX_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const CSS = `@font-face{font-family:Geist;src:url(/assets/fonts/geist.woff2) format("woff2");font-weight:100 900;font-display:swap}
@font-face{font-family:"Geist Mono";src:url(/assets/fonts/geist-mono.woff2) format("woff2");font-weight:100 900;font-display:swap}
:root{--page:#858584;--card:#080808;--line:#2e2e31;--panel:#1b1b1e;--field:#1d1d20;--fg:#eeeeec;--muted:#9b9b9f;--btn:#e4e4e1}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:var(--page);color:var(--fg);font:15px/1.55 Geist,Arial,sans-serif;padding:24px 16px}
main{max-width:720px;margin:0 auto;background:var(--card);border:1px solid var(--line);border-radius:28px;padding:28px 24px}
.brand{display:flex;align-items:center;gap:8px;margin:0 0 18px;font:600 11px/1 "Geist Mono",monospace;letter-spacing:.14em;color:var(--muted)}
.brand::before{content:"";width:8px;height:8px;background:var(--fg)}
h1{font-size:24px;line-height:1.2;margin:0 0 8px}p{margin:8px 0;color:var(--muted)}
form{display:flex;gap:8px;margin:16px 0}input{flex:1;min-width:0;padding:12px 14px;border-radius:12px;border:1px solid #4a4a4d;background:var(--field);color:var(--fg);font:14px "Geist Mono",monospace}
button{padding:12px 18px;border:1px solid var(--btn);border-radius:999px;background:var(--btn);color:#111;font:500 15px Geist,Arial,sans-serif;cursor:pointer}
.sum{padding:14px;border-radius:14px;background:var(--panel);border:1px solid var(--line);color:var(--fg);margin:16px 0;overflow-wrap:anywhere}
ol{padding-left:20px}li{margin:10px 0;overflow-wrap:anywhere}code,.mono{font-family:"Geist Mono",monospace;font-size:13px;overflow-wrap:anywhere}
dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 14px;margin:16px 0;font-size:14px}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}`;

function shell(title: string, body: string, hash = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body><main>
<div class="brand">COFER · TRANSACTION EXPLAINER</div>
<h1>What happened in this transaction?</h1>
<p>Paste a transaction hash from Robinhood Chain. Only Cofer contracts are read; anything else is left out.</p>
<form method="get" action="/tx"><input name="hash" value="${esc(hash)}" placeholder="0x…" aria-label="Transaction hash" autocomplete="off" spellcheck="false"><button type="submit">Explain</button></form>
${body}
<p><small>Read-only. The same answer as JSON: <code>/v1/tx/&lt;hash&gt;</code>.</small></p>
</main></body></html>`;
}

export function txFormPage(message = ""): string {
  return shell("Cofer transaction explainer", message ? `<div class="sum">${esc(message)}</div>` : "");
}

export function txResultPage(e: Explanation, explorer?: string): string {
  const link = explorer ? ` · <a href="${esc(`${explorer.replace(/\/$/, "")}/tx/${e.hash}`)}" style="color:var(--fg)">explorer</a>` : "";
  const when = e.time ? `${new Date(e.time * 1000).toISOString().slice(0, 19).replace("T", " ")} UTC` : "unknown";
  return shell(
    `Cofer transaction ${e.hash.slice(0, 10)}…`,
    `<div class="sum">${esc(e.summary)}</div>
<dl><dt>Hash</dt><dd class="mono">${esc(e.hash)}${link}</dd><dt>Result</dt><dd>${e.status}</dd><dt>Block</dt><dd class="mono">${e.block}</dd><dt>Time</dt><dd>${when}</dd><dt>From</dt><dd class="mono">${esc(e.from)}</dd><dt>To</dt><dd class="mono">${esc(e.to ?? "a new contract")}</dd></dl>
${e.events.length ? `<ol>${e.events.map((x) => `<li>${esc(x.text)} <small>(${esc(x.contract)}, ${esc(x.event)})</small></li>`).join("")}</ol>` : ""}`,
    e.hash,
  );
}
