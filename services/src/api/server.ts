import { Hono } from "hono";
import { trpcServer } from "@hono/trpc-server";
import { webhookCallback, type Bot } from "grammy";
import { appRouter, type ApiCtx } from "./router";
import { verifyLink } from "../core/linkToken";
import { signerPage, signerRpcUrl, SIGNER_CSP } from "../web/page";
import { env, type Env } from "../env";
import { logError } from "../core/errors";
import type { ProposalDeps } from "../services/proposals";
import type { CardAdapter } from "../cards/CardAdapter";
import { dashboardRoutes, type DashboardDeps } from "../dashboard/routes";

export async function buildSignerBundle(): Promise<string> {
  const out = await Bun.build({ entrypoints: [new URL("../web/client.ts", import.meta.url).pathname], target: "browser", minify: true });
  if (!out.success) throw new Error(out.logs.map(String).join("\n"));
  return await out.outputs[0]!.text();
}

/**
 * @param opts.env settings to use instead of the process environment (tests pass fixed values).
 * @param opts.dashboard the read-only dashboard API's data source; omitted = no dashboard routes.
 */
export function createServer(opts: { deps: ProposalDeps; cards: CardAdapter | null; bot?: Bot; signerJs: string; env?: Env; dashboard?: DashboardDeps }) {
  const e = opts.env ?? env();
  const pageRpc = signerRpcUrl(e);
  const app = new Hono();

  // Any other route error: plain text out, logged without URLs.
  app.onError((err, c) => {
    logError("api", err);
    return c.text("Internal error", 500);
  });

  app.get("/healthz", (c) => c.json({ ok: true }));

  // read-only dashboard API (dashboard/routes.ts); the dashboard site reaches it on its own address
  if (opts.dashboard) app.route("/api/dashboard", dashboardRoutes(opts.dashboard));

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

  app.get("/s/:token", (c) => {
    c.header("content-security-policy", SIGNER_CSP);
    c.header("x-frame-options", "DENY");
    return c.html(
      signerPage(c.req.param("token"), {
        chainId: e.CHAIN_ID,
        rpcUrl: pageRpc, // never RHC_RPC_URL: the page is readable by every member
        bundlerUrl: e.BUNDLER_URL ?? "",
        paymasterUrl: e.PAYMASTER_URL ?? "",
        passkeyServerUrl: e.PASSKEY_SERVER_URL ?? "",
        usdg: e.USDG_ADDRESS,
        factory: e.FACTORY_ADDRESS, // public; the page checks isPot before any vote is signed
        adapter: e.ADAPTER_ADDRESS, // public; an exit may never be sent to it
      }),
    );
  });

  return app;
}
