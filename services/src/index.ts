/**
 * Process entry. ROLE picks the components so each can scale/deploy separately:
 *   api      Hono (tRPC signer API, signer page, Telegram webhook)
 *   bot      long-polling bot (development only; production uses the api webhook)
 *   indexer  log watcher -> Postgres projections
 *   keeper   relay worker + scheduled jobs (expire, sweep, stocks, holdings, feeds, ops, health),
 *            plus the team bot on the alert bot where TEAMBOT_ENABLED=1 on mainnet (teambot/start.ts)
 *   notifier Telegram card posts/edits
 *   all      everything in one process (small deployments)
 */
import { env } from "./env";
import { assertFactoryUsdg, factoryAddress, publicClient } from "./chain/clients";
import { createBot, proposalDeps } from "./bot/bot";
import { createServer, buildSignerBundle, buildWalletBundle } from "./api/server";
import { startIndexer } from "./indexer/indexer";
import { startKeeper, scheduleKeeper } from "./keeper/keeper";
import { startRelayer } from "./relayer/relayer";
import { startNotifier } from "./notifier/notifier";
import { selectCardAdapter } from "./cards/select";
import { dashboardData } from "./dashboard/data";
import { countErrorsWith, logError } from "./core/errors";
import { recordError } from "./keeper/serverHealth";
import { maybeStartTeambot } from "./teambot/start";
import { livePublicApiDeps } from "./publicapi/deps";
import { liveMetricsDeps } from "./api/liveMetrics";

async function main() {
  const e = env();
  // every logged error, in every role, counts toward the errors-spike alert (Redis down: not counted)
  countErrorsWith(() => void recordError().catch(() => {}));
  const role = e.ROLE;
  // checked first, in every role: a card setting that must never run (e.g. the stub off testnet) stops start-up
  const cards = selectCardAdapter(e);
  await assertFactoryUsdg(publicClient(), factoryAddress(), e.USDG_ADDRESS);
  const bot = createBot({ cardsOn: cards !== null });
  const run = (r: string) => role === "all" || role === r;

  if (run("api")) {
    // the dashboard API exists only where a dashboard is set up (DASHBOARD_URL)
    const dashboard = e.DASHBOARD_URL
      ? dashboardData({ client: publicClient(), factory: factoryAddress(), usdg: e.USDG_ADDRESS, chainId: e.CHAIN_ID, secret: e.LINK_SECRET, signerUrl: e.PUBLIC_URL })
      : undefined;
    // Connect wallet: only with REOWN_PROJECT_ID. Missing, or a failed build, turns it off with a clear line; the passkey never depends on it.
    let walletJs: string | null = null;
    if (!e.REOWN_PROJECT_ID) {
      console.log("[api] REOWN_PROJECT_ID is not set: Connect wallet is off. Passkey sign-up and signing work as before. Wallet members (kernel-ecdsa) see that Connect wallet is not available.");
    } else {
      walletJs = await buildWalletBundle().catch((err) => {
        logError("api wallet bundle (Connect wallet is off; passkeys work as before)", err);
        return null;
      });
      if (walletJs) console.log("[api] Connect wallet is on");
    }
    const publicApi = livePublicApiDeps(e);
    const app = createServer({ deps: proposalDeps(), cards, bot, signerJs: await buildSignerBundle(), walletJs, dashboard, publicApi, metrics: liveMetricsDeps(publicApi) });
    Bun.serve({ port: e.PORT, fetch: app.fetch });
    if (e.BOT_MODE === "webhook") {
      await bot.api.setWebhook(`${e.PUBLIC_URL}/tg/webhook`, {
        secret_token: e.TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: ["message", "callback_query"],
      });
    }
    console.log(`[api] :${e.PORT}`);
  }
  if ((role === "bot" || role === "all") && e.BOT_MODE === "polling") {
    void bot.start();
    console.log("[bot] polling");
  }
  if (run("indexer")) void startIndexer();
  if (run("keeper")) {
    await scheduleKeeper();
    startKeeper();
    startRelayer();
    console.log("[keeper] + [relayer] up");
    if (maybeStartTeambot(e)) console.log("[teambot] up");
  }
  if (run("notifier")) {
    startNotifier(bot.api);
    console.log("[notifier] up");
  }
}

// Anything not caught elsewhere is logged without URLs (RPC addresses, the bot token in Telegram API URLs).
process.on("unhandledRejection", (e) => logError("unhandled", e));
process.on("uncaughtException", (e) => {
  logError("uncaught", e);
  process.exit(1);
});

main().catch((err) => {
  logError("startup", err);
  process.exit(1);
});
