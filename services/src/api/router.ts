/**
 * tRPC v11 router for the signer site. Auth = short-lived session minted from a one-time bot link.
 * The session identifies a Telegram user; money only moves with that member's own signature
 * (EIP-712 votes) or their own smart-account userOps (deposit/spend/exit).
 */
import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";
import { eq, isNull, or } from "drizzle-orm";
import { getAddress, type Address, type Hex, type PublicClient } from "viem";
import { schema, type DB } from "../db/client";
import { potAbi } from "../chain/clients";
import { signLink, verifyLink, newJti, type LinkClaims } from "../core/linkToken";
import { addSignature, createProposal, getSignable, ProposalError, readRules, type ProposalDeps } from "../services/proposals";
import { Kind } from "../core/proposal";
import { previewExit } from "../core/shares";
import type { CardAdapter } from "../cards/CardAdapter";
import { RPC_UNREACHABLE_TEXT, userMessage } from "../core/errors";

export interface ApiCtx {
  deps: ProposalDeps;
  cards: CardAdapter | null; // null = cards are off (cards/select.ts)
  secret: string;
  session: LinkClaims | null;
}

/**
 * What an API error may tell the browser. Errors thrown on purpose (TRPCError with a code, input
 * validation, ProposalError via wrap) keep their fixed text. Anything unexpected arrives as
 * INTERNAL_SERVER_ERROR and is replaced by fixed text: its own message can hold the RPC address.
 * Stack traces are never sent.
 */
export function safeErrorShape<S extends { message: string; data: { stack?: string } }>(shape: S, error: TRPCError): S {
  const message = error.code === "INTERNAL_SERVER_ERROR" ? userMessage(error.cause ?? error, RPC_UNREACHABLE_TEXT) : shape.message;
  const { stack: _stack, ...data } = shape.data;
  return { ...shape, message, data };
}

const t = initTRPC.context<ApiCtx>().create({ errorFormatter: ({ shape, error }) => safeErrorShape(shape, error) });
const authed = t.procedure.use(({ ctx, next }) => {
  if (!ctx.session || ctx.session.p !== "session") throw new TRPCError({ code: "UNAUTHORIZED" });
  return next({ ctx: { ...ctx, session: ctx.session } });
});

const zAddr = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((a) => getAddress(a));
const zHex = z.string().regex(/^0x[0-9a-fA-F]*$/).transform((h) => h as Hex);
const zBig = z.union([z.string(), z.number()]).transform((v) => BigInt(v));

const zAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal(Kind.TRANSFER), asset: zAddr, to: zAddr, amount: zBig }),
  z.object({ kind: z.literal(Kind.ADD_MEMBER), member: zAddr }),
  z.object({ kind: z.literal(Kind.REMOVE_MEMBER), member: zAddr }),
  z.object({ kind: z.literal(Kind.SET_ALLOWANCE), member: zAddr, amount: zBig, period: z.number().int() }),
  z.object({ kind: z.literal(Kind.SET_THRESHOLD), threshold: z.number().int(), thresholdBps: z.number().int() }),
  z.object({
    kind: z.literal(Kind.SET_CONFIG),
    guardDelay: z.number().int(),
    maxSlipBps: z.number().int(),
    entrySpreadBps: z.number().int(),
    depositsOpen: z.boolean(),
  }),
  z.object({ kind: z.literal(Kind.PAY_PLAN), months: z.number().int() }),
  // SWAP proposals are built server-side from pool + oracle quotes (bot /buy, /sell)
]);

const wrap = async <T>(f: () => Promise<T>) => {
  try {
    return await f();
  } catch (e) {
    if (e instanceof ProposalError) throw new TRPCError({ code: "BAD_REQUEST", message: e.message });
    throw e;
  }
};

const linkClaims = (token: string, secret: string): LinkClaims => {
  try {
    return verifyLink(token, secret);
  } catch {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "link expired or invalid; tap the button in Telegram again" });
  }
};

export const appRouter = t.router({
  session: t.router({
    /**
     * Read-only look at a one-time link: checks HMAC + expiry, but does not spend it and does not
     * create a session. Opening or previewing the page (e.g. in Telegram's in-app browser) must not
     * use up the link; only the action button calls exchange.
     */
    preview: t.procedure.input(z.object({ token: z.string() })).query(async ({ ctx, input }) => {
      const claims = linkClaims(input.token, ctx.secret);
      const row = await ctx.deps.db.query.linkTokens.findFirst({ where: eq(schema.linkTokens.jti, claims.jti) });
      const used = !!row?.usedAt;
      let proposal: { summary: string; approvals: number; required: number; stale: boolean } | null = null;
      if (!used && claims.p === "sign" && claims.ref.startsWith("0x")) {
        const p = await wrap(() => getSignable(ctx.deps, claims.ref as Hex));
        proposal = { summary: p.summary, approvals: p.tally.approvals, required: p.tally.required, stale: p.stale };
      }
      // the sign-up page needs this before any passkey is created, so a second sign-up never makes a new one
      let linked: string | null = null;
      if (claims.p === "onboard") {
        const user = await ctx.deps.db.query.users.findFirst({ where: eq(schema.users.tgId, claims.tg) });
        linked = user?.address ?? null;
      }
      return { used, purpose: claims.p, ref: claims.ref, proposal, linked };
    }),
    /** Exchange a one-time bot link for a 1h session (link is single-use via jti). */
    exchange: t.procedure.input(z.object({ token: z.string() })).mutation(async ({ ctx, input }) => {
      const claims = linkClaims(input.token, ctx.secret);
      // one atomic statement: of two simultaneous taps, only one gets a row back
      const now = new Date();
      const spent = await ctx.deps.db
        .insert(schema.linkTokens)
        .values({ jti: claims.jti, tgId: claims.tg, purpose: claims.p, usedAt: now, expiresAt: new Date(claims.exp * 1000) })
        .onConflictDoUpdate({ target: schema.linkTokens.jti, set: { usedAt: now }, setWhere: isNull(schema.linkTokens.usedAt) })
        .returning({ jti: schema.linkTokens.jti });
      if (spent.length === 0) throw new TRPCError({ code: "UNAUTHORIZED", message: "link already used" });
      const session = signLink({ ...claims, p: "session", exp: Math.floor(Date.now() / 1000) + 3600, jti: newJti() }, ctx.secret);
      return { session, purpose: claims.p, ref: claims.ref, chat: claims.chat };
    }),
  }),

  me: t.router({
    get: authed.query(async ({ ctx }) => ctx.deps.db.query.users.findFirst({ where: eq(schema.users.tgId, ctx.session.tg) })),
    /** Bind the member key to this Telegram account. verifyMessage supports ERC-1271/6492 accounts. */
    link: authed
      .input(z.object({ address: zAddr, signature: zHex, kind: z.enum(["kernel-passkey", "safe-webauthn", "eoa"]) }))
      .mutation(async ({ ctx, input }) => {
        const message = linkMessage(ctx.session.tg, ctx.session.jti);
        const ok = await (ctx.deps.client as PublicClient).verifyMessage({ address: input.address, message, signature: input.signature });
        if (!ok) throw new TRPCError({ code: "BAD_REQUEST", message: "signature does not match" });
        // one key per Telegram account: linking the same address again is fine (a retry), a different one is refused
        const keyTaken = (linked: string) =>
          new TRPCError({ code: "CONFLICT", message: `this Telegram account already has a Cofer key (${linked}); replacing a key is not supported yet` });
        const existing = await ctx.deps.db.query.users.findFirst({ where: eq(schema.users.tgId, ctx.session.tg) });
        if (existing?.address && getAddress(existing.address) !== input.address) throw keyTaken(existing.address);
        // the setWhere repeats the check inside the write, so two sign-ups at the same moment cannot both win
        const saved = await ctx.deps.db
          .insert(schema.users)
          .values({ tgId: ctx.session.tg, address: input.address, accountKind: input.kind, linkedAt: new Date() })
          .onConflictDoUpdate({
            target: schema.users.tgId,
            set: { address: input.address, accountKind: input.kind, linkedAt: new Date() },
            setWhere: or(isNull(schema.users.address), eq(schema.users.address, input.address)),
          })
          .returning({ address: schema.users.address });
        if (saved.length === 0) {
          const now = await ctx.deps.db.query.users.findFirst({ where: eq(schema.users.tgId, ctx.session.tg) });
          throw keyTaken(now?.address ?? "another address");
        }
        return { ok: true };
      }),
    linkMessage: authed.query(({ ctx }) => ({ message: linkMessage(ctx.session.tg, ctx.session.jti) })),
    setRegion: authed.input(z.object({ region: z.string().regex(/^[A-Za-z]{2}$/) })).mutation(async ({ ctx, input }) => {
      await ctx.deps.db.update(schema.users).set({ region: input.region.toUpperCase() }).where(eq(schema.users.tgId, ctx.session.tg));
      return { ok: true };
    }),
  }),

  pot: t.router({
    get: authed.input(z.object({ pot: zAddr })).query(async ({ ctx, input }) => {
      const c = ctx.deps.client;
      const [rules, held, total] = await Promise.all([
        readRules(c, input.pot),
        c.readContract({ address: input.pot, abi: potAbi, functionName: "heldAssets" }),
        c.readContract({ address: input.pot, abi: potAbi, functionName: "totalShares" }),
      ]);
      const holdings = await ctx.deps.db.select().from(schema.holdings).where(eq(schema.holdings.pot, input.pot));
      return { ...rules, epoch: rules.epoch.toString(), heldAssets: held, totalShares: total.toString(), holdings };
    }),
    /** Exact in-kind amounts a member would receive (same floor rounding as the contract). */
    previewExit: authed.input(z.object({ pot: zAddr, shares: zBig })).query(async ({ ctx, input }) => {
      const c = ctx.deps.client;
      const [held, total] = await Promise.all([
        c.readContract({ address: input.pot, abi: potAbi, functionName: "heldAssets" }),
        c.readContract({ address: input.pot, abi: potAbi, functionName: "totalShares" }),
      ]);
      const dist = await Promise.all(held.map((a) => c.readContract({ address: input.pot, abi: potAbi, functionName: "distributable", args: [a] })));
      const amounts = previewExit(input.shares, total, dist);
      return held.map((a: Address, i: number) => ({ asset: a, amount: amounts[i]!.toString() }));
    }),
  }),

  proposal: t.router({
    create: authed.input(z.object({ pot: zAddr, action: zAction })).mutation(({ ctx, input }) =>
      wrap(async () => {
        const p = await createProposal(ctx.deps, { pot: input.pot, action: input.action, proposerTg: ctx.session.tg });
        return { id: p.id, summary: p.summary, typedData: p.typedData };
      }),
    ),
    get: authed.input(z.object({ id: zHex })).query(({ ctx, input }) => wrap(() => getSignable(ctx.deps, input.id))),
    sign: authed.input(z.object({ id: zHex, signer: zAddr, signature: zHex })).mutation(({ ctx, input }) =>
      wrap(async () => {
        const tl = await addSignature(ctx.deps, { id: input.id, tgId: ctx.session.tg, signer: input.signer, signature: input.signature });
        return { approvals: tl.approvals, required: tl.required, ready: tl.ready, delaySeconds: tl.delaySeconds };
      }),
    ),
  }),

  card: t.router({
    quote: authed.input(z.object({ pot: zAddr, amountUsdg: zBig })).mutation(async ({ ctx, input }) => {
      const cards = cardsOrRefuse(ctx.cards);
      const user = await ctx.deps.db.query.users.findFirst({ where: eq(schema.users.tgId, ctx.session.tg) });
      if (!user?.address) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "link your key first" });
      const q = await cards.quote({ pot: input.pot, member: getAddress(user.address), amountUsdg: input.amountUsdg });
      if (!q) throw new TRPCError({ code: "BAD_REQUEST", message: "cards are not available for this amount or region" });
      await ctx.deps.db.insert(schema.cardOrders).values({
        id: q.orderId,
        pot: input.pot,
        member: user.address,
        amountUsdg: q.amountUsdg.toString(),
        provider: cards.name,
        fundingAddress: q.fundingAddress,
        status: "quoted",
      });
      // The signer site then sends CoferPot.spend(q.fundingAddress, q.amountUsdg, q.memo) as a userOp.
      return { ...q, amountUsdg: q.amountUsdg.toString(), loadFeeUsdg: q.loadFeeUsdg.toString() };
    }),
    confirm: authed.input(z.object({ orderId: z.string(), spendTx: zHex })).mutation(async ({ ctx, input }) => {
      const cards = cardsOrRefuse(ctx.cards);
      // only the member who asked for the quote may confirm it (same answer whether the order is missing or someone else's)
      const [user, order] = await Promise.all([
        ctx.deps.db.query.users.findFirst({ where: eq(schema.users.tgId, ctx.session.tg) }),
        ctx.deps.db.query.cardOrders.findFirst({ where: eq(schema.cardOrders.id, input.orderId) }),
      ]);
      if (!order || !user?.address || getAddress(order.member) !== getAddress(user.address)) {
        throw new TRPCError({ code: "NOT_FOUND", message: "unknown card order" });
      }
      const st = await cards.confirm(input);
      await ctx.deps.db.update(schema.cardOrders).set({ status: st.status, spendTx: input.spendTx }).where(eq(schema.cardOrders.id, input.orderId));
      return st;
    }),
  }),
});

export type AppRouter = typeof appRouter;

/** Cards are optional and off by default: refuse the card routes when no adapter runs. */
function cardsOrRefuse(cards: CardAdapter | null): CardAdapter {
  if (!cards) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "cards are not available" });
  return cards;
}

export function linkMessage(tgId: number, nonce: string): string {
  return `Link Telegram account ${tgId} to my Cofer key.\nNonce: ${nonce}`;
}
