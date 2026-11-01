/**
 * Cofer Telegram bot: a PLAIN bot (no Mini App), commands + inline buttons. Everything that moves
 * money opens the external signer site via a one-time `url` link, where the member signs with
 * their own passkey. A tap in Telegram is never authorization.
 */
import { Bot, type Context } from "grammy";
import { and, eq, ilike } from "drizzle-orm";
import { encodeFunctionData, formatUnits, getAddress, keccak256, toHex, type Address, type Hex } from "viem";
import { env } from "../env";
import { db, schema } from "../db/client";
import { factoryAbi, factoryAddress, feeRouterAbi, potAbi, publicClient, relayerClient, erc20Abi } from "../chain/clients";
import { Kind, type Action, type TokenMeta } from "../core/proposal";
import { createProposal, ProposalError, getSignable, type ProposalDeps } from "../services/proposals";
import { computeMinOut, queuedSwapNote, swapInAfterFee } from "../core/swap";
import { shownQuantity } from "../core/valuation";
import { chooseTier, quoteAllTiers } from "../chain/quotes";
import { depthRefusal, depthTestSize, type Side } from "../core/depth";
import { errorKind, logError, revertName, RPC_ERROR_TEXT, UserError, userMessage } from "../core/errors";
import { enqueueNotify, enqueueRelay, redis } from "../queues";
import { assertNoMiniApp, linkButton, signerUrl } from "./keyboards";
import { parseAllowance, parseBuy, parseSell, parseSend, parseUsdg } from "./parse";
import { privateReply, type PrivateReplyDeps } from "./privateReply";
import { noMiniApp } from "./noMiniApp";
import { chatRateLimit, RateLimited, redisStore, updateUser } from "./rateLimit";
import { verifyLink } from "../core/linkToken";
import { alertDeps } from "../keeper/alerts";
import { allowanceLeft } from "../core/shares";
import { roomLeft, roomText } from "../core/betaCap";
import { buyPause, potNote } from "../core/buyPause";
import { continuityAlertKey } from "../core/continuity";
import { CARDS_OFF_TEXT, helpText } from "./help";
import { newPotRefusal } from "./newpotLimit";

export const DEFAULT_CONFIG = { guardDelay: 6 * 3600, maxSlipBps: 300, entrySpreadBps: 50, depositsOpen: true } as const;
export const DEFAULT_THRESHOLD_BPS = 6000; // 3 of 5, 2 of 3, 3 of 4 ...

export function proposalDeps(): ProposalDeps {
  return {
    db: db(),
    client: publicClient(),
    chainId: env().CHAIN_ID,
    factory: factoryAddress(),
    tokens: tokenMetaSync,
    names: (a) => nameCache.get(a.toLowerCase()) ?? `${a.slice(0, 6)}…${a.slice(-4)}`,
    enqueueRelay: (id) => enqueueRelay(id),
    notify: (id) => enqueueNotify(id),
  };
}

const usdg = () => env().USDG_ADDRESS;
const USDG_META: TokenMeta = { symbol: "USDG", decimals: 6 };
const tokenCache = new Map<string, TokenMeta>();
const nameCache = new Map<string, string>();
function tokenMetaSync(a: Address): TokenMeta {
  if (a.toLowerCase() === usdg().toLowerCase()) return USDG_META;
  return tokenCache.get(a.toLowerCase()) ?? { symbol: "?", decimals: 18 };
}
async function warmToken(a: Address) {
  if (a.toLowerCase() === usdg().toLowerCase() || tokenCache.has(a.toLowerCase())) return;
  const [symbol, decimals] = await Promise.all([
    publicClient().readContract({ address: a, abi: erc20Abi, functionName: "symbol" }),
    publicClient().readContract({ address: a, abi: erc20Abi, functionName: "decimals" }),
  ]);
  tokenCache.set(a.toLowerCase(), { symbol, decimals });
}

function linkCtx(ctx: Context) {
  return { publicUrl: env().PUBLIC_URL, secret: env().LINK_SECRET, tgId: ctx.from!.id, chatId: ctx.chat!.id };
}

async function userOf(tgId: number) {
  return db().query.users.findFirst({ where: eq(schema.users.tgId, tgId) });
}

async function potOf(chatId: number) {
  return db().query.pots.findFirst({ where: eq(schema.pots.chatId, chatId) });
}

/** Cancels a one-time signer link (marks it used), e.g. one that was shown to a whole group. */
async function burnLink(href: string) {
  const c = verifyLink(new URL(href).pathname.split("/s/")[1] ?? "", env().LINK_SECRET);
  const now = new Date();
  await db()
    .insert(schema.linkTokens)
    .values({ jti: c.jti, tgId: c.tg, purpose: c.p, usedAt: now, expiresAt: new Date(c.exp * 1000) })
    .onConflictDoUpdate({ target: schema.linkTokens.jti, set: { usedAt: now } });
}

function privateDeps(ctx: Context): PrivateReplyDeps {
  return {
    send: (chatId, text, opts) => ctx.api.sendMessage(chatId, text, opts as never),
    remove: (chatId, messageId) => ctx.api.deleteMessage(chatId, messageId),
    burn: burnLink,
    leaked: (chatId) =>
      alertDeps()
        .send(`A personal message was shown to a whole group (chat ${chatId}) instead of only to one member. It was deleted, its link was cancelled, and the member got it by DM. Check that ephemeral messages still work.`)
        .catch((e) => logError("bot", e)),
  };
}

/** A reply only the tapping member sees (ephemeral in a group, else a DM); see privateReply.ts. */
async function ephemeral(ctx: Context, text: string, link?: { label: string; make(): string }) {
  const r = await privateReply(privateDeps(ctx), { chatId: ctx.chat!.id, chatType: ctx.chat!.type, userId: ctx.from!.id, callbackQueryId: ctx.callbackQuery?.id, text, link });
  if (r === "none") await ctx.reply("Open a private chat with me first, then try again.");
}

/** Link context for an onboarding link: always the member's private chat (chat id = user id), never a group. */
function onboardLinkCtx(ctx: Context) {
  return { ...linkCtx(ctx), chatId: ctx.from!.id };
}

export const ONBOARD_TEXT = "First set up your key (a passkey on your phone). Takes 20 seconds.";
export const ONBOARD_SENT_BY_DM = "I sent you a private message to set up your key.";
export const ONBOARD_DM_FIRST = "Open a private chat with me and send /start first, then try again.";

/**
 * Onboarding links bind a key to a Telegram account, so they go ONLY by DM: never into a group,
 * not even as an ephemeral message (one that Telegram showed to everyone could be tapped by someone
 * else before it was cancelled). The signer API also refuses an onboarding link not made for a DM.
 */
async function sendOnboardingLink(ctx: Context) {
  const kb = linkButton("Set up my key", signerUrl(onboardLinkCtx(ctx), "onboard"));
  assertNoMiniApp(kb);
  try {
    await ctx.api.sendMessage(ctx.from!.id, ONBOARD_TEXT, { reply_markup: kb });
  } catch {
    await ctx.reply(ONBOARD_DM_FIRST); // no link in this reply
    return;
  }
  if (ctx.chat!.type !== "private") await ephemeral(ctx, ONBOARD_SENT_BY_DM); // no link in this reply either
}

async function requireLinked(ctx: Context) {
  const u = await userOf(ctx.from!.id);
  if (u?.address) return u;
  await sendOnboardingLink(ctx);
  return null;
}

/** @param note optional extra text for the proposer (e.g. queuedSwapNote for swaps). */
async function propose(ctx: Context, action: Action, note?: string | null) {
  const pot = await potOf(ctx.chat!.id);
  if (!pot) return ctx.reply("No group account here yet. An admin can run /newpot.");
  try {
    const p = await createProposal(proposalDeps(), { pot: getAddress(pot.address), action, proposerTg: ctx.from!.id });
    await ephemeral(ctx, `Proposed: ${p.summary}\nYour vote counts only once you sign it.${note ? `\n\n${note}` : ""}`, {
      label: "Sign my vote",
      make: () => signerUrl(linkCtx(ctx), "sign", p.id),
    });
  } catch (e) {
    await replyError(ctx, e);
  }
}

/** Replies with fixed text only (never raw error text, which can hold the RPC URL) and logs the rest without URLs. */
async function replyError(ctx: Context, e: unknown) {
  if (!(e instanceof UserError)) logError("bot", e);
  await ctx.reply(userMessage(e));
}

/** True while the keeper's multiplier continuity alert is open for this stock. */
async function continuityOpen(asset: string) {
  return !!(await db().query.alerts.findFirst({ where: eq(schema.alerts.key, continuityAlertKey(asset)) }));
}

async function findAsset(symbol: string) {
  return db().query.assets.findFirst({ where: and(ilike(schema.assets.symbol, symbol), eq(schema.assets.listedOnChain, true)) });
}

/** CoferFactory.quote (Chainlink), with stale feeds and RPC failures reported as such. */
async function oracleQuote(tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<bigint> {
  try {
    return await publicClient().readContract({ address: factoryAddress(), abi: factoryAbi, functionName: "quote", args: [tokenIn, tokenOut, amountIn] });
  } catch (e) {
    if (errorKind(e) === "rpc") throw new ProposalError(RPC_ERROR_TEXT);
    const name = revertName(e);
    if (name === "StalePrice" || name === "BadPrice") {
      throw new ProposalError("price feed is paused (market closed or corporate action). Try again when the market reopens.");
    }
    logError("bot", e);
    throw new ProposalError("could not read the price for that pair");
  }
}

/** The swap vote, plus the note explaining the exit-window wait (audit H-2) from the group's own settings. */
async function buildSwap(pot: Address, side: Side, tokenIn: Address, tokenOut: Address, amountIn: bigint, slipBps: number): Promise<{ action: Action; note: string | null }> {
  const c = publicClient();
  const [feeBps, cfg] = await Promise.all([
    c.readContract({ address: factoryAddress(), abi: factoryAbi, functionName: "swapFeeBps" }),
    c.readContract({ address: pot, abi: potAbi, functionName: "config" }),
  ]);
  const { swapIn } = swapInAfterFee(amountIn, Number(feeBps));
  // Depth is tested at max(trade, DEPTH_TEST_USDG) for buys and at the sale size for sells.
  const depthIn = depthTestSize(side, swapIn);
  const same = depthIn === swapIn;
  const [oracleOut, oracleDepthOut, tradeQuotes, depthQuotes] = await Promise.all([
    oracleQuote(tokenIn, tokenOut, swapIn),
    same ? undefined : oracleQuote(tokenIn, tokenOut, depthIn),
    quoteAllTiers(c, tokenIn, tokenOut, swapIn),
    same ? undefined : quoteAllTiers(c, tokenIn, tokenOut, depthIn),
  ]);
  const choice = chooseTier(tradeQuotes, depthQuotes ?? tradeQuotes, oracleDepthOut ?? oracleOut);
  if (choice.kind === "rpc-error") throw new ProposalError(RPC_ERROR_TEXT); // never propose from partial results
  if (choice.kind === "too-thin") throw new ProposalError(depthRefusal(side));
  if (choice.kind === "no-pool") throw new ProposalError("no Uniswap pool can quote that pair right now");
  const q = choice.quote;
  const r = computeMinOut({ poolOut: q.out, oracleOut, userSlipBps: slipBps, potMaxSlipBps: Number(cfg[1]) });
  if (!r.ok) throw new ProposalError(r.reason);
  const action: Action = { kind: Kind.SWAP, adapter: getAddress(env().ADAPTER_ADDRESS), tokenIn, tokenOut, amountIn, minOut: r.minOut, route: q.path };
  return { action, note: queuedSwapNote({ side, guardDelaySec: Number(cfg[0]), slipBps, maxSlipBps: Number(cfg[1]) }) };
}

async function resolveMember(ctx: Context, who: string): Promise<Address | null> {
  if (/^0x[0-9a-fA-F]{40}$/.test(who)) return getAddress(who);
  const handle = who.replace(/^@/, "");
  const u = await db().query.users.findFirst({ where: ilike(schema.users.username, handle) });
  if (!u?.address) {
    await ctx.reply(`@${handle} hasn't set up a key yet.`);
    return null;
  }
  nameCache.set(u.address.toLowerCase(), `@${handle}`);
  return getAddress(u.address);
}

/** @param opts.cardsOn true only when a card adapter runs (index.ts: selectCardAdapter); otherwise /card is hidden. */
export function createBot(opts: { cardsOn: boolean }) {
  const bot = new Bot(env().TELEGRAM_BOT_TOKEN);
  bot.api.config.use(noMiniApp); // every outgoing call, including the notifier's (it uses bot.api)
  bot.api.config.use(chatRateLimit(redisStore(redis() as unknown as Parameters<typeof redisStore>[0]))); // per-chat budgets, shared via Redis
  const rateStore = redisStore(redis() as unknown as Parameters<typeof redisStore>[0]); // same Redis counters, for per-user limits (/newpot)

  // which member this update is for, so a reply that cannot go to a busy group can go to them by DM
  bot.use((ctx, next) => updateUser.run({ userId: ctx.from?.id }, next));

  // Before every command (only the member record above runs first), so it covers both polling and webhook mode: an error
  // reaches the chat only as fixed text, and the logs never see a URL.
  bot.use(async (ctx, next) => {
    try {
      await next();
    } catch (e) {
      if (e instanceof RateLimited) return; // the group is busy and no DM was possible: dropped (the member can run it again)
      logError("bot", e);
      if (ctx.chat) await ctx.reply(userMessage(e)).catch(() => {});
    }
  });

  bot.command("start", async (ctx) => {
    if (ctx.chat.type !== "private") return ctx.reply("Hi! Run /newpot to open a group account, or /help.");
    await db()
      .insert(schema.users)
      .values({ tgId: ctx.from!.id, username: ctx.from!.username ?? null })
      .onConflictDoUpdate({ target: schema.users.tgId, set: { username: ctx.from!.username ?? null } });
    const kb = linkButton("Set up my key", signerUrl(onboardLinkCtx(ctx), "onboard"));
    assertNoMiniApp(kb);
    await ctx.reply(
      "Cofer is a shared money account for your group chat, on Robinhood Chain.\n\nYou'll create a passkey on this phone. It's your key: votes and withdrawals need it, so nobody (including us) can move your share without you.",
      { reply_markup: kb },
    );
  });

  // For the operator: the ID of this private chat, to put in OPS_CHAT_ID. Not in /help. Silent in groups.
  bot.command("chatid", async (ctx) => {
    if (ctx.chat.type !== "private") return;
    await ctx.reply(`This chat's ID: ${ctx.chat.id}\nTo get keeper alerts here, set OPS_CHAT_ID=${ctx.chat.id} for the services.`);
  });

  bot.command("region", async (ctx) => {
    const code = (ctx.match ?? "").trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) return ctx.reply("Usage: /region XX (two-letter country code)");
    await db().update(schema.users).set({ region: code }).where(eq(schema.users.tgId, ctx.from!.id));
    await ctx.reply(`Saved: ${code}.`);
  });

  bot.command("newpot", async (ctx) => {
    if (ctx.chat.type === "private") return ctx.reply("Add me to your group and run /newpot there.");
    const u = await requireLinked(ctx);
    if (!u) return;
    if (await potOf(ctx.chat.id)) return ctx.reply("This group already has an account. /pot to see it.");
    // per-user limit, taken before the relayer pays for anything
    const refusal = await newPotRefusal(rateStore, ctx.from!.id);
    if (refusal) return ctx.reply(refusal);
    const salt = keccak256(toHex(`cofer:${ctx.chat.id}`));
    const wallet = relayerClient();
    const members = [getAddress(u.address!)];
    const config = { ...DEFAULT_CONFIG };
    const { request, result } = await publicClient().simulateContract({
      account: wallet.account,
      address: factoryAddress(),
      abi: factoryAbi,
      functionName: "createPot",
      args: [members, 0, DEFAULT_THRESHOLD_BPS, config, salt],
    });
    const hash = await wallet.writeContract(request);
    await publicClient().waitForTransactionReceipt({ hash });
    await db().insert(schema.pots).values({
      address: getAddress(result),
      chatId: ctx.chat.id,
      title: "title" in ctx.chat ? ctx.chat.title : "Group",
      creatorTg: ctx.from!.id,
      threshold: 0,
      thresholdBps: DEFAULT_THRESHOLD_BPS,
      guardDelay: config.guardDelay,
      maxSlipBps: config.maxSlipBps,
      entrySpreadBps: config.entrySpreadBps,
    });
    await ctx.reply(
      `Group account open: ${result}\n\nEveryone: /join to request a seat (members vote you in). Votes need 60% of members. Anyone can /exit with their exact share at any time.`,
    );
  });

  bot.command("join", async (ctx) => {
    const u = await requireLinked(ctx);
    if (!u) return;
    nameCache.set(u.address!.toLowerCase(), ctx.from!.username ? `@${ctx.from!.username}` : ctx.from!.first_name);
    await propose(ctx, { kind: Kind.ADD_MEMBER, member: getAddress(u.address!) });
  });

  bot.command("deposit", async (ctx) => {
    if (!(await requireLinked(ctx))) return;
    const pot = await potOf(ctx.chat.id);
    if (!pot) return ctx.reply("No group account here yet.");
    // beta limit: shown when the value can be read; the signer page checks it again before anything is signed
    let room: string | null = null;
    try {
      const [nav] = await publicClient().readContract({ address: getAddress(pot.address), abi: potAbi, functionName: "navUsdg" });
      if (roomLeft(nav) === 0n) return ephemeral(ctx, roomText(nav)!);
      room = roomText(nav);
    } catch {
      /* not shown; the signer page refuses if it cannot read the value */
    }
    const intro = "Add USDG to the group account. You'll get shares for exactly what you put in.";
    await ephemeral(ctx, room ? `${intro}\n${room}` : intro, {
      label: "Deposit",
      make: () => signerUrl(linkCtx(ctx), "deposit", pot.address),
    });
  });

  bot.command("claim", async (ctx) => {
    if (!(await requireLinked(ctx))) return;
    const pot = await potOf(ctx.chat.id);
    if (!pot) return ctx.reply("No group account here yet.");
    await ephemeral(ctx, "Claim a token that was set aside for you when you exited (for example, one its issuer had paused). This does not exit or change your share.", {
      label: "Claim my set-aside token",
      make: () => signerUrl(linkCtx(ctx), "claim", pot.address),
    });
  });

  bot.command("exit", async (ctx) => {
    if (!(await requireLinked(ctx))) return;
    const pot = await potOf(ctx.chat.id);
    if (!pot) return ctx.reply("No group account here yet.");
    await ephemeral(ctx, "Take your exact share of everything the group holds (USDG and any stocks, as they are). No vote needed. Never paused.", {
      label: "Exit with my share",
      make: () => signerUrl(linkCtx(ctx), "exit", pot.address),
    });
  });

  bot.command("me", async (ctx) => {
    const u = await requireLinked(ctx);
    if (!u) return;
    const pot = await potOf(ctx.chat.id);
    if (!pot) return ctx.reply("No group account here yet.");
    const info = await publicClient().readContract({ address: getAddress(pot.address), abi: potAbi, functionName: "memberInfo", args: [getAddress(u.address!)] });
    const total = await publicClient().readContract({ address: getAddress(pot.address), abi: potAbi, functionName: "totalShares" });
    const pct = total === 0n ? 0 : Number((info.shares * 10_000n) / total) / 100;
    const left = allowanceLeft(
      { allowance: info.allowance, period: Number(info.period), periodStart: Number(info.periodStart), spent: info.spent },
      Math.floor(Date.now() / 1000),
    );
    await ephemeral(ctx, `Your share: ${pct}% of the pot.\nAllowance left: ${formatUnits(left, 6)} USDG.`);
  });

  bot.command("buy", async (ctx) => {
    if (!(await requireLinked(ctx))) return;
    const pot = await potOf(ctx.chat.id);
    if (!pot) return ctx.reply("No group account here yet.");
    try {
      const cmd = parseBuy(ctx.message!.text);
      const asset = await findAsset(cmd.symbol);
      if (!asset) return ctx.reply(`${cmd.symbol} isn't on the list.`);
      // new buys only: /sell, exit and leave never check this
      const paused = buyPause(asset, await continuityOpen(asset.address), Math.floor(Date.now() / 1000));
      if (paused) return ctx.reply(paused);
      const out = getAddress(asset.address);
      tokenCache.set(out.toLowerCase(), { symbol: asset.symbol, decimals: asset.decimals });
      const s = await buildSwap(getAddress(pot.address), "buy", usdg(), out, cmd.usdg, cmd.slipBps);
      await propose(ctx, s.action, s.note);
    } catch (e) {
      await replyError(ctx, e);
    }
  });

  bot.command("sell", async (ctx) => {
    if (!(await requireLinked(ctx))) return;
    const pot = await potOf(ctx.chat.id);
    if (!pot) return ctx.reply("No group account here yet.");
    try {
      const cmd = parseSell(ctx.message!.text);
      const asset = await findAsset(cmd.symbol);
      if (!asset) return ctx.reply(`${cmd.symbol} isn't on the list.`);
      const tokenIn = getAddress(asset.address);
      tokenCache.set(tokenIn.toLowerCase(), { symbol: asset.symbol, decimals: asset.decimals });
      const avail = await publicClient().readContract({ address: getAddress(pot.address), abi: potAbi, functionName: "distributable", args: [tokenIn] });
      const amountIn = (avail * BigInt(cmd.pctBps)) / 10_000n;
      if (amountIn === 0n) return ctx.reply(`The group holds no ${asset.symbol}.`);
      const s = await buildSwap(getAddress(pot.address), "sell", tokenIn, usdg(), amountIn, cmd.slipBps);
      await propose(ctx, s.action, s.note);
    } catch (e) {
      await replyError(ctx, e);
    }
  });

  bot.command("send", async (ctx) => {
    if (!(await requireLinked(ctx))) return;
    try {
      const cmd = parseSend(ctx.message!.text);
      const to = await resolveMember(ctx, cmd.to);
      if (to) await propose(ctx, { kind: Kind.TRANSFER, asset: usdg(), to, amount: cmd.usdg });
    } catch (e) {
      await replyError(ctx, e);
    }
  });

  bot.command("allowance", async (ctx) => {
    if (!(await requireLinked(ctx))) return;
    try {
      const cmd = parseAllowance(ctx.message!.text);
      const who = await resolveMember(ctx, cmd.who);
      if (who) await propose(ctx, { kind: Kind.SET_ALLOWANCE, member: who, amount: cmd.usdg, period: cmd.period });
    } catch (e) {
      await replyError(ctx, e);
    }
  });

  bot.command("spend", async (ctx) => {
    if (!(await requireLinked(ctx))) return;
    const pot = await potOf(ctx.chat.id);
    if (!pot) return ctx.reply("No group account here yet.");
    await ephemeral(ctx, "Spend from your own allowance. No vote needed.", { label: "Spend", make: () => signerUrl(linkCtx(ctx), "sign", `spend:${pot.address}`) });
  });

  bot.command("card", async (ctx) => {
    if (!opts.cardsOn) return ctx.reply(CARDS_OFF_TEXT);
    if (!(await requireLinked(ctx))) return;
    const pot = await potOf(ctx.chat.id);
    if (!pot) return ctx.reply("No group account here yet.");
    await ephemeral(ctx, "Load a card from your allowance (optional; issued by a third-party card provider, availability varies by region).", {
      label: "Load a card",
      make: () => signerUrl(linkCtx(ctx), "card", pot.address),
    });
  });

  bot.command("plan", async (ctx) => {
    if (!(await requireLinked(ctx))) return;
    const months = Number((ctx.match ?? "").trim() || "1");
    if (!Number.isInteger(months) || months < 1 || months > 12) return ctx.reply("Usage: /plan MONTHS (1-12)");
    // the vote carries today's cost as its maximum: if the price rises before it runs, the pot refuses to pay
    let maxCost: bigint;
    try {
      const router = await publicClient().readContract({ address: factoryAddress(), abi: factoryAbi, functionName: "feeRouter" });
      maxCost = (await publicClient().readContract({ address: router, abi: feeRouterAbi, functionName: "planPricePerMonth" })) * BigInt(months);
    } catch (e) {
      return replyError(ctx, errorKind(e) === "rpc" ? new ProposalError(RPC_ERROR_TEXT) : e);
    }
    await propose(ctx, { kind: Kind.PAY_PLAN, months, maxCost });
  });

  bot.command("pot", async (ctx) => {
    const pot = await potOf(ctx.chat.id);
    if (!pot) return ctx.reply("No group account here yet.");
    const rows = await db().select().from(schema.holdings).where(eq(schema.holdings.pot, pot.address));
    const now = Math.floor(Date.now() / 1000);
    const lines: string[] = [];
    for (const r of rows) {
      const meta = tokenMetaSync(getAddress(r.asset));
      const stock = await db().query.assets.findFirst({ where: eq(schema.assets.address, r.asset) });
      // shown quantity = raw x multiplier (after a 2-for-1 split, 1 raw TSLA shows as 2); value is raw x feed
      const qty = shownQuantity(BigInt(r.rawBalance) - BigInt(r.reserved), meta.decimals, stock?.isStock ? stock.currentMultiplier : null);
      const val = r.valueUsdg ? `${formatUnits(BigInt(r.valueUsdg), 6)} USDG` : "price paused";
      const note = stock?.isStock ? potNote(stock, await continuityOpen(r.asset), now) : null;
      lines.push(`${meta.symbol}: ${qty} (${val})${note ? ` · ${note}` : ""}`);
    }
    await ctx.reply([`Group account ${pot.address}`, ...lines].join("\n") || "Empty.");
  });

  bot.command("help", (ctx) => ctx.reply(helpText({ cardsOn: opts.cardsOn })));

  bot.callbackQuery(/^sign:(0x[0-9a-f]{64})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!(await requireLinked(ctx))) return;
    await ephemeral(ctx, "Review the exact action and sign with your passkey.", { label: "Review & sign", make: () => signerUrl(linkCtx(ctx), "sign", ctx.match[1]) });
  });

  bot.callbackQuery(/^info:(0x[0-9a-f]{64})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const s = await getSignable({ db: db(), client: publicClient() }, ctx.match[1] as Hex);
    await ephemeral(ctx, `${s.summary}\nStatus: ${s.status}\nSigned by ${s.tally.approvals} of ${s.tally.required} needed.`);
  });

  // Last stop for any command: log without URLs, reply with fixed text only.
  bot.catch(async (err) => {
    if (err.error instanceof RateLimited) return;
    logError("bot", err.error);
    await err.ctx.reply(userMessage(err.error)).catch(() => {});
  });
  return bot;
}

export { encodeFunctionData, parseUsdg, warmToken };
