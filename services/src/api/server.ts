import { Hono } from "hono";
import { trpcServer } from "@hono/trpc-server";
import { webhookCallback, type Bot } from "grammy";
import { appRouter, type ApiCtx } from "./router";
import { verifyLink } from "../core/linkToken";
import { signerPage, signerRpcUrl, SIGNER_CSP } from "../web/page";
import { env } from "../env";
import { logError } from "../core/errors";
import type { ProposalDeps } from "../services/proposals";
import type { CardAdapter } from "../cards/CardAdapter";

export async function buildSignerBundle(): Promise<string> {
  const out = await Bun.build({ entrypoints: [new URL("../web/client.ts", import.meta.url).pathname], target: "browser", minify: true });
  if (!out.success) throw new Error(out.logs.map(String).join("\n"));
  return await out.outputs[0]!.text();
}

export function createServer(opts: { deps: ProposalDeps; cards: CardAdapter | null; bot?: Bot; signerJs: string }) {
  const e = env();
  const pageRpc = signerRpcUrl(e);
  const app = new Hono();

  // Any other route error: plain text out, logged without URLs.
  app.onError((err, c) => {
    logError("api", err);
    return c.text("Internal error", 500);
  });

  app.get("/healthz", (c) => c.json({ ok: true }));

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
      }),
    );
  });

  return app;
}
