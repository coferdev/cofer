/**
 * Process entry. ROLE picks the components so each can scale/deploy separately:
 *   api      Hono (tRPC signer API, signer page, Telegram webhook)
 *   bot      long-polling bot (development only; production uses the api webhook)
 *   indexer  log watcher -> Postgres projections
 *   keeper   relay worker + scheduled jobs (expire, sweep, stocks, holdings, feeds)
 *   notifier Telegram card posts/edits
 *   all      everything in one process (small deployments)
 */
import { env } from "./env";
import { assertFactoryUsdg, factoryAddress, publicClient } from "./chain/clients";
import { createBot, proposalDeps } from "./bot/bot";
import { createServer, buildSignerBundle } from "./api/server";
import { startIndexer } from "./indexer/indexer";
import { startKeeper, scheduleKeeper } from "./keeper/keeper";
import { startRelayer } from "./relayer/relayer";
import { startNotifier } from "./notifier/notifier";
import { StubCardAdapter } from "./cards/StubCardAdapter";
import type { CardAdapter } from "./cards/CardAdapter";

function cards(): CardAdapter {
  if (env().CARD_ADAPTER === "provider") {
    throw new Error("Provider card adapter is out of band: implement CardAdapter for the provider's API (see cards/CardAdapter.ts)");
  }
  return new StubCardAdapter();
}

async function main() {
  const e = env();
  const role = e.ROLE;
  await assertFactoryUsdg(publicClient(), factoryAddress(), e.USDG_ADDRESS);
  const bot = createBot();
  const run = (r: string) => role === "all" || role === r;

  if (run("api")) {
    const app = createServer({ deps: proposalDeps(), cards: cards(), bot, signerJs: await buildSignerBundle() });
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
  }
  if (run("notifier")) {
    startNotifier(bot.api);
    console.log("[notifier] up");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
