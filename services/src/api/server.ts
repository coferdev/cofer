import { readFileSync } from "node:fs";
import { Hono, type Context } from "hono";
import { trpcServer } from "@hono/trpc-server";
import { webhookCallback, type Bot } from "grammy";
import { appRouter, type ApiCtx } from "./router";
import { verifyLink } from "../core/linkToken";
import { signerPage, signerRpcUrl, SIGNER_CSP, WALLET_CSP, type PageCfg } from "../web/page";
import { env, type Env } from "../env";
import { logError } from "../core/errors";
import type { ProposalDeps } from "../services/proposals";
import type { CardAdapter } from "../cards/CardAdapter";
import { dashboardRoutes, type DashboardDeps } from "../dashboard/routes";
import { publicApi, type PublicApiDeps } from "../publicapi/router";
import { isTxHash } from "../publicapi/tx";
import { TX_PAGE_CSP, txFormPage, txResultPage } from "../web/txPage";
import { explorerFor } from "../chain/addresses";

export async function buildSignerBundle(): Promise<string> {
  const out = await Bun.build({ entrypoints: [new URL("../web/client.ts", import.meta.url).pathname], target: "browser", minify: true });
  if (!out.success) throw new Error(out.logs.map(String).join("\n"));
  return await out.outputs[0]!.text();
}

/**
 * The signer pages' fonts (Geist and Geist Mono, SIL Open Font License, src/web/fonts/LICENSE),
 * served from this server: no outside font service, and the pages' policy needs no font host.
 * Only these two fixed names exist; nothing is read from the request path.
 */
const fontFile = (name: string) => new Uint8Array(readFileSync(new URL(`../web/fonts/${name}`, import.meta.url)));
export const SIGNER_FONTS: Record<string, Uint8Array<ArrayBuffer>> = {
  "geist.woff2": fontFile("geist.woff2"),
  "geist-mono.woff2": fontFile("geist-mono.woff2"),
};

/**
 * The wallet window (Reown AppKit) as its own file, /assets/wallet.js, loaded only by the wallet page.
 * Built only when REOWN_PROJECT_ID is set; a failed build turns Connect wallet off, never the passkey.
 */
export async function buildWalletBundle(): Promise<string> {
  const out = await Bun.build({
    entrypoints: [new URL("../web/wallet.ts", import.meta.url).pathname],
    target: "browser",
    format: "esm",
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
  });
  if (!out.success) throw new Error(out.logs.map(String).join("\n"));
  return await out.outputs[0]!.text();
}

/**
 * @param opts.env settings to use instead of the process environment (tests pass fixed values).
 * @param opts.dashboard the read-only dashboard API's data source; omitted = no dashboard routes.
 * @param opts.walletJs the wallet bundle (buildWalletBundle); omitted or null = Connect wallet is off.
 * @param opts.publicApi the public read-only API's data sources (publicapi/); omitted = no /v1 routes.
 */
export function createServer(opts: { deps: ProposalDeps; cards: CardAdapter | null; bot?: Bot; signerJs: string; walletJs?: string | null; env?: Env; dashboard?: DashboardDeps; publicApi?: PublicApiDeps }) {
  const e = opts.env ?? env();
  const pageRpc = signerRpcUrl(e);
  // Connect wallet needs both the public Reown project ID and the built wallet file; otherwise it is off and the passkey works as before
  const walletOn = !!(e.REOWN_PROJECT_ID && opts.walletJs);
  const app = new Hono();

  // Any other route error: plain text out, logged without URLs.
  app.onError((err, c) => {
    logError("api", err);
    return c.text("Internal error", 500);
  });

  app.get("/healthz", (c) => c.json({ ok: true }));

  // read-only dashboard API (dashboard/routes.ts); the dashboard site reaches it on its own address
  if (opts.dashboard) app.route("/api/dashboard", dashboardRoutes(opts.dashboard));

  // the public read-only API: on-chain data only, rate limited, CORS open for GET (publicapi/router.ts)
  const pub = opts.publicApi ? publicApi(opts.publicApi) : null;
  if (pub) {
    app.route("/v1", pub.app);
    // the transaction explainer page: no script, rate limited with the public API
    const page = (c: Context, html: string, status: 200 | 400 | 404 | 429 = 200) => {
      c.header("content-security-policy", TX_PAGE_CSP);
      c.header("x-frame-options", "DENY");
      c.header("cache-control", status === 200 ? "public, max-age=300" : "no-store");
      return c.html(html, status);
    };
    app.get("/tx", (c) => {
      const h = (c.req.query("hash") ?? "").trim();
      if (!h) return page(c, txFormPage());
      return isTxHash(h) ? c.redirect(`/tx/${h}`, 302) : page(c, txFormPage("A transaction hash is 0x followed by 64 hex characters."), 400);
    });
    app.get("/tx/:hash", async (c) => {
      if (pub.limit(c.req.header("x-forwarded-for")) > 0) return page(c, txFormPage("Too many requests. Wait a little and try again."), 429);
      const h = c.req.param("hash");
      if (!isTxHash(h)) return page(c, txFormPage("A transaction hash is 0x followed by 64 hex characters."), 400);
      const ex = await pub.explainTx(h);
      return ex ? page(c, txResultPage(ex, explorerFor(e.CHAIN_ID, e.EXPLORER_URL))) : page(c, txFormPage("No transaction with this hash on this chain (yet)."), 404);
    });
  }

  app.use(
    "/trpc/*",
    trpcServer({
      router: appRouter,
      createContext: (_o, c) => {
        const auth = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
        let session = null;
        if (auth) {
          try {
            session = verifyLink(auth, e.LINK_SECRET);
          } catch {
            session = null;
          }
        }
        const ctx: ApiCtx = { deps: opts.deps, cards: opts.cards, secret: e.LINK_SECRET, session };
        return ctx as unknown as Record<string, unknown>;
      },
      // the browser gets fixed text (router errorFormatter); the full error goes to the log, without URLs
      onError: ({ error, path }) => {
        if (error.code === "INTERNAL_SERVER_ERROR") logError(`api ${path ?? "?"}`, error.cause ?? error);
      },
    }),
  );

  if (opts.bot && e.BOT_MODE === "webhook") {
    // Telegram echoes the secret in X-Telegram-Bot-Api-Secret-Token; grammY rejects mismatches.
    app.post("/tg/webhook", webhookCallback(opts.bot, "hono", { secretToken: e.TELEGRAM_WEBHOOK_SECRET }));
  }

  app.get("/assets/signer.js", (c) => c.body(opts.signerJs, 200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300" }));
  app.get("/assets/fonts/:name", (c) => {
    const font = Object.hasOwn(SIGNER_FONTS, c.req.param("name")) ? SIGNER_FONTS[c.req.param("name")] : undefined;
    if (!font) return c.text("Not found", 404);
    return c.body(font, 200, { "content-type": "font/woff2", "cache-control": "public, max-age=604800" });
  });

  if (walletOn) {
    const walletJs = opts.walletJs!;
    app.get("/assets/wallet.js", (c) => c.body(walletJs, 200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300" }));
  }

  const pageCfg: PageCfg = {
    chainId: e.CHAIN_ID,
    rpcUrl: pageRpc, // never RHC_RPC_URL: the page is readable by every member
    bundlerUrl: e.BUNDLER_URL ?? "",
    paymasterUrl: e.PAYMASTER_URL ?? "",
    passkeyServerUrl: e.PASSKEY_SERVER_URL ?? "",
    usdg: e.USDG_ADDRESS,
    factory: e.FACTORY_ADDRESS, // public; the page checks isPot before any vote is signed
    adapter: e.ADAPTER_ADDRESS, // public; an exit may never be sent to it
    walletOn,
  };

  // the passkey page: its policy is unchanged by Connect wallet (the wallet window never loads here)
  app.get("/s/:token", (c) => {
    c.header("content-security-policy", SIGNER_CSP);
    c.header("x-frame-options", "DENY");
    return c.html(signerPage(c.req.param("token"), { ...pageCfg, mode: "passkey" }));
  });

  // the wallet page: same shell, Connect wallet only. With Connect wallet off it keeps the strict policy and says so.
  app.get("/w/:token", (c) => {
    c.header("content-security-policy", walletOn ? WALLET_CSP : SIGNER_CSP);
    c.header("x-frame-options", "DENY");
    return c.html(signerPage(c.req.param("token"), { ...pageCfg, mode: "wallet", ...(walletOn ? { reownProjectId: e.REOWN_PROJECT_ID, walletJs: "/assets/wallet.js" } : {}) }));
  });

  return app;
}
