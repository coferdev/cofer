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
import { factoryAbi, factoryAddress, potAbi, publicClient, relayerClient, erc20Abi } from "../chain/clients";
import { RHC } from "../chain/addresses";
import { Kind, type Action, type TokenMeta } from "../core/proposal";
import { createProposal, ProposalError, getSignable, type ProposalDeps } from "../services/proposals";
import { computeMinOut, encodeV3Path, swapInAfterFee } from "../core/swap";
import { enqueueNotify, enqueueRelay } from "../queues";
import { assertNoMiniApp, linkButton, signerUrl } from "./keyboards";
import { parseAllowance, parseBuy, parseSell, parseSend, parseUsdg } from "./parse";
import { allowanceLeft } from "../core/shares";

const QUOTER_V2_ABI = [
  {
    type: "function",
    name: "quoteExactInput",
    stateMutability: "nonpayable",
    inputs: [{ type: "bytes", name: "path" }, { type: "uint256", name: "amountIn" }],
    outputs: [
      { type: "uint256", name: "amountOut" },
      { type: "uint160[]", name: "sqrtPriceX96AfterList" },
      { type: "uint32[]", name: "initializedTicksCrossedList" },
      { type: "uint256", name: "gasEstimate" },
    ],
  },
] as const;

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

const tokenCache = new Map<string, TokenMeta>([[RHC.USDG.toLowerCase(), { symbol: "USDG", decimals: 6 }]]);
const nameCache = new Map<string, string>();
function tokenMetaSync(a: Address): TokenMeta {
  return tokenCache.get(a.toLowerCase()) ?? { symbol: "?", decimals: 18 };
}
async function warmToken(a: Address) {
  if (tokenCache.has(a.toLowerCase())) return;
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

/** Sends a message only the tapping user sees (Bot API 10.2 ephemeral), falling back to a DM. */
async function ephemeral(ctx: Context, text: string, url?: { label: string; href: string }) {
  const kb = url ? linkButton(url.label, url.href) : undefined;
  if (kb) assertNoMiniApp(kb);
  const extra = kb ? { reply_markup: kb } : {};
  try {
    await ctx.api.sendMessage(ctx.chat!.id, text, {
      ...extra,
      ephemeral_message_parameters: { receiver_user_id: ctx.from!.id, callback_query_id: ctx.callbackQuery?.id },
    });
  } catch {
    await ctx.api.sendMessage(ctx.from!.id, text, extra).catch(() => ctx.reply("Open a private chat with me first, then try again."));
  }
}

async function requireLinked(ctx: Context) {
  const u = await userOf(ctx.from!.id);
  if (u?.address) return u;
  await ephemeral(ctx, "First set up your key (a passkey on your phone). Takes 20 seconds.", {
    label: "Set up my key",
    href: signerUrl(linkCtx(ctx), "onboard"),
  });
  return null;
}

async function propose(ctx: Context, action: Action) {
  const pot = await potOf(ctx.chat!.id);
  if (!pot) return ctx.reply("No group account here yet. An admin can run /newpot.");
  try {
    const p = await createProposal(proposalDeps(), { pot: getAddress(pot.address), action, proposerTg: ctx.from!.id });
    await ephemeral(ctx, `Proposed: ${p.summary}\nYour vote counts only once you sign it.`, {
      label: "Sign my vote",
      href: signerUrl(linkCtx(ctx), "sign", p.id),
    });
  } catch (e) {
    await ctx.reply(e instanceof ProposalError ? e.message : "Could not create that vote.");
    if (!(e instanceof ProposalError)) console.error(e);
  }
}

async function findAsset(symbol: string) {
  return db().query.assets.findFirst({ where: and(ilike(schema.assets.symbol, symbol), eq(schema.assets.listedOnChain, true)) });
}

/** Best v3 fee tier quote among common tiers; Stock Token pool tiers on RHC vary (verify per asset). */
async function bestQuote(tokenIn: Address, tokenOut: Address, amountIn: bigint) {
  let best: { out: bigint; path: Hex } | null = null;
  for (const fee of [500, 3000, 10000]) {
    const path = encodeV3Path([tokenIn, tokenOut], [fee]);
    try {
      const { result } = await publicClient().simulateContract({ address: RHC.UNI_V3_QUOTER_V2, abi: QUOTER_V2_ABI, functionName: "quoteExactInput", args: [path, amountIn] });
      if (!best || result[0] > best.out) best = { out: result[0], path };
    } catch {
      /* no pool at this tier */
    }
  }
  return best;
}

async function buildSwap(pot: Address, tokenIn: Address, tokenOut: Address, amountIn: bigint, slipBps: number): Promise<Action> {
  const c = publicClient();
  const [feeBps, cfg] = await Promise.all([
    c.readContract({ address: factoryAddress(), abi: factoryAbi, functionName: "swapFeeBps" }),
    c.readContract({ address: pot, abi: potAbi, functionName: "config" }),
  ]);
  const { swapIn } = swapInAfterFee(amountIn, Number(feeBps));
  const q = await bestQuote(tokenIn, tokenOut, swapIn);
  if (!q) throw new ProposalError("no Uniswap pool found for that pair");
  let oracleOut: bigint;
  try {
    oracleOut = await c.readContract({ address: factoryAddress(), abi: factoryAbi, functionName: "quote", args: [tokenIn, tokenOut, swapIn] });
  } catch {
    throw new ProposalError("price feed is paused (market closed or corporate action). Try again when the market reopens.");
  }
  const r = computeMinOut({ poolOut: q.out, oracleOut, userSlipBps: slipBps, potMaxSlipBps: Number(cfg[1]) });
  if (!r.ok) throw new ProposalError(r.reason);
  return { kind: Kind.SWAP, adapter: getAddress(env().ADAPTER_ADDRESS), tokenIn, tokenOut, amountIn, minOut: r.minOut, route: q.path };
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

export function createBot() {
  const bot = new Bot(env().TELEGRAM_BOT_TOKEN);

  bot.command("start", async (ctx) => {
    if (ctx.chat.type !== "private") return ctx.reply("Hi! Run /newpot to open a group account, or /help.");
    await db()
      .insert(schema.users)
      .values({ tgId: ctx.from!.id, username: ctx.from!.username ?? null })
      .onConflictDoUpdate({ target: schema.users.tgId, set: { username: ctx.from!.username ?? null } });
    const kb = linkButton("Set up my key", signerUrl(linkCtx(ctx), "onboard"));
    assertNoMiniApp(kb);
    await ctx.reply(
      "Cofer is a shared money account for your group chat, on Robinhood Chain.\n\nYou'll create a passkey on this phone. It's your key: votes and withdrawals need it, so nobody (including us) can move your share without you.",
      { reply_markup: kb },
    );
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
    await ephemeral(ctx, "Add USDG to the group account. You'll get shares for exactly what you put in.", {
      label: "Deposit",
      href: signerUrl(linkCtx(ctx), "deposit", pot.address),
    });
  });

  bot.command(["exit", "claim"], async (ctx) => {
    if (!(await requireLinked(ctx))) return;
    const pot = await potOf(ctx.chat.id);
    if (!pot) return ctx.reply("No group account here yet.");
    await ephemeral(ctx, "Take your exact share of everything the group holds (USDG and any stocks, as they are). No vote needed. Never paused.", {
      label: "Exit with my share",
      href: signerUrl(linkCtx(ctx), "exit", pot.address),
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
      const out = getAddress(asset.address);
      tokenCache.set(out.toLowerCase(), { symbol: asset.symbol, decimals: asset.decimals });
      await propose(ctx, await buildSwap(getAddress(pot.address), RHC.USDG, out, cmd.usdg, cmd.slipBps));
    } catch (e) {
      await ctx.reply((e as Error).message);
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
      await propose(ctx, await buildSwap(getAddress(pot.address), tokenIn, RHC.USDG, amountIn, 100));
    } catch (e) {
      await ctx.reply((e as Error).message);
    }
  });

  bot.command("send", async (ctx) => {
    if (!(await requireLinked(ctx))) return;
    try {
      const cmd = parseSend(ctx.message!.text);
      const to = await resolveMember(ctx, cmd.to);
      if (to) await propose(ctx, { kind: Kind.TRANSFER, asset: RHC.USDG, to, amount: cmd.usdg });
    } catch (e) {
      await ctx.reply((e as Error).message);
    }
  });

  bot.command("allowance", async (ctx) => {
    if (!(await requireLinked(ctx))) return;
    try {
      const cmd = parseAllowance(ctx.message!.text);
      const who = await resolveMember(ctx, cmd.who);
      if (who) await propose(ctx, { kind: Kind.SET_ALLOWANCE, member: who, amount: cmd.usdg, period: cmd.period });
    } catch (e) {
      await ctx.reply((e as Error).message);
    }
  });

  bot.command("spend", async (ctx) => {
    if (!(await requireLinked(ctx))) return;
    const pot = await potOf(ctx.chat.id);
    if (!pot) return ctx.reply("No group account here yet.");
    await ephemeral(ctx, "Spend from your own allowance. No vote needed.", { label: "Spend", href: signerUrl(linkCtx(ctx), "sign", `spend:${pot.address}`) });
  });

  bot.command("card", async (ctx) => {
    if (!(await requireLinked(ctx))) return;
    const pot = await potOf(ctx.chat.id);
    if (!pot) return ctx.reply("No group account here yet.");
    await ephemeral(ctx, "Load a card from your allowance (optional; issued by a third-party card provider, availability varies by region).", {
      label: "Load a card",
      href: signerUrl(linkCtx(ctx), "card", pot.address),
    });
  });

  bot.command("plan", async (ctx) => {
    if (!(await requireLinked(ctx))) return;
    const months = Number((ctx.match ?? "").trim() || "1");
    if (!Number.isInteger(months) || months < 1 || months > 12) return ctx.reply("Usage: /plan MONTHS (1-12)");
    await propose(ctx, { kind: Kind.PAY_PLAN, months });
  });

  bot.command("pot", async (ctx) => {
    const pot = await potOf(ctx.chat.id);
    if (!pot) return ctx.reply("No group account here yet.");
    const rows = await db().select().from(schema.holdings).where(eq(schema.holdings.pot, pot.address));
    const lines = rows.map((r) => {
      const meta = tokenMetaSync(getAddress(r.asset));
      const qty = formatUnits(BigInt(r.rawBalance) - BigInt(r.reserved), meta.decimals);
      const val = r.valueUsdg ? `${formatUnits(BigInt(r.valueUsdg), 6)} USDG` : "price paused";
      return `${meta.symbol}: ${qty} (${val})`;
    });
    await ctx.reply([`Group account ${pot.address}`, ...lines].join("\n") || "Empty.");
  });

  bot.command("help", (ctx) =>
    ctx.reply(
      [
        "/newpot open the group account",
        "/join ask to join (members vote)",
        "/deposit add USDG",
        "/buy TSLA 100 vote to buy with 100 USDG",
        "/sell TSLA 50% vote to sell",
        "/send 50 @bob vote to send",
        "/allowance @amy 50 week set a no-vote allowance",
        "/spend spend your allowance",
        "/card load a card from your allowance (optional)",
        "/exit take your exact share, any time",
        "/me your share and allowance",
        "/pot what the group holds",
        "/region XX declare your country (stock buys)",
      ].join("\n"),
    ),
  );

  bot.callbackQuery(/^sign:(0x[0-9a-f]{64})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!(await requireLinked(ctx))) return;
    await ephemeral(ctx, "Review the exact action and sign with your passkey.", { label: "Review & sign", href: signerUrl(linkCtx(ctx), "sign", ctx.match[1]) });
  });

  bot.callbackQuery(/^info:(0x[0-9a-f]{64})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const s = await getSignable({ db: db(), client: publicClient() }, ctx.match[1] as Hex);
    await ephemeral(ctx, `${s.summary}\nStatus: ${s.status}\nSigned by ${s.tally.approvals} of ${s.tally.required} needed.`);
  });

  bot.catch((err) => console.error("[bot]", err.error));
  return bot;
}

export { encodeFunctionData, parseUsdg, warmToken };
