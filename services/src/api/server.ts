import { Hono } from "hono";
import { trpcServer } from "@hono/trpc-server";
import { webhookCallback, type Bot } from "grammy";
import { appRouter, type ApiCtx } from "./router";
import { verifyLink } from "../core/linkToken";
import { signerPage } from "../web/page";
import { env } from "../env";
import type { ProposalDeps } from "../services/proposals";
import type { CardAdapter } from "../cards/CardAdapter";

export async function buildSignerBundle(): Promise<string> {
  const out = await Bun.build({ entrypoints: [new URL("../web/client.ts", import.meta.url).pathname], target: "browser", minify: true });
  if (!out.success) throw new Error(out.logs.map(String).join("\n"));
  return await out.outputs[0]!.text();
}

export function createServer(opts: { deps: ProposalDeps; cards: CardAdapter; bot?: Bot; signerJs: string }) {
  const e = env();
  const app = new Hono();

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
    }),
  );

  if (opts.bot && e.BOT_MODE === "webhook") {
    // Telegram echoes the secret in X-Telegram-Bot-Api-Secret-Token; grammY rejects mismatches.
    app.post("/tg/webhook", webhookCallback(opts.bot, "hono", { secretToken: e.TELEGRAM_WEBHOOK_SECRET }));
  }

  app.get("/assets/signer.js", (c) => c.body(opts.signerJs, 200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300" }));

  app.get("/s/:token", (c) => {
    c.header("content-security-policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src *; frame-ancestors 'none'");
    c.header("x-frame-options", "DENY");
    return c.html(
      signerPage(c.req.param("token"), {
        chainId: e.CHAIN_ID,
        rpcUrl: e.RHC_RPC_URL,
        bundlerUrl: e.BUNDLER_URL ?? "",
        paymasterUrl: e.PAYMASTER_URL ?? "",
        passkeyServerUrl: e.PASSKEY_SERVER_URL ?? "",
      }),
    );
  });

  return app;
}
