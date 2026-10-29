/**
 * tRPC v11 router for the signer site. Auth = short-lived session minted from a one-time bot link.
 * The session identifies a Telegram user; money only moves with that member's own signature
 * (EIP-712 votes) or their own smart-account userOps (deposit/spend/exit).
 */
import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getAddress, type Address, type Hex, type PublicClient } from "viem";
import { schema, type DB } from "../db/client";
import { potAbi } from "../chain/clients";
import { signLink, verifyLink, newJti, type LinkClaims } from "../core/linkToken";
import { addSignature, createProposal, getSignable, ProposalError, readRules, type ProposalDeps } from "../services/proposals";
import { Kind } from "../core/proposal";
import { previewExit } from "../core/shares";
import type { CardAdapter } from "../cards/CardAdapter";

export interface ApiCtx {
  deps: ProposalDeps;
  cards: CardAdapter;
  secret: string;
  session: LinkClaims | null;
}

const t = initTRPC.context<ApiCtx>().create();
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

export const appRouter = t.router({
  session: t.router({
    /** Exchange a one-time bot link for a 1h session (link is single-use via jti). */
    exchange: t.procedure.input(z.object({ token: z.string() })).mutation(async ({ ctx, input }) => {
      let claims: LinkClaims;
      try {
        claims = verifyLink(input.token, ctx.secret);
      } catch {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "link expired or invalid; tap the button in Telegram again" });
      }
      const db = ctx.deps.db;
      const used = await db.query.linkTokens.findFirst({ where: eq(schema.linkTokens.jti, claims.jti) });
      if (used?.usedAt) throw new TRPCError({ code: "UNAUTHORIZED", message: "link already used" });
      await db
        .insert(schema.linkTokens)
        .values({ jti: claims.jti, tgId: claims.tg, purpose: claims.p, usedAt: new Date(), expiresAt: new Date(claims.exp * 1000) })
        .onConflictDoUpdate({ target: schema.linkTokens.jti, set: { usedAt: new Date() } });
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
        await ctx.deps.db
          .insert(schema.users)
          .values({ tgId: ctx.session.tg, address: input.address, accountKind: input.kind, linkedAt: new Date() })
          .onConflictDoUpdate({ target: schema.users.tgId, set: { address: input.address, accountKind: input.kind, linkedAt: new Date() } });
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
      const user = await ctx.deps.db.query.users.findFirst({ where: eq(schema.users.tgId, ctx.session.tg) });
      if (!user?.address) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "link your key first" });
      const q = await ctx.cards.quote({ pot: input.pot, member: getAddress(user.address), amountUsdg: input.amountUsdg });
      if (!q) throw new TRPCError({ code: "BAD_REQUEST", message: "cards are not available for this amount or region" });
      await ctx.deps.db.insert(schema.cardOrders).values({
        id: q.orderId,
        pot: input.pot,
        member: user.address,
        amountUsdg: q.amountUsdg.toString(),
        provider: ctx.cards.name,
        fundingAddress: q.fundingAddress,
        status: "quoted",
      });
      // The signer site then sends CoferPot.spend(q.fundingAddress, q.amountUsdg, q.memo) as a userOp.
      return { ...q, amountUsdg: q.amountUsdg.toString(), loadFeeUsdg: q.loadFeeUsdg.toString() };
    }),
    confirm: authed.input(z.object({ orderId: z.string(), spendTx: zHex })).mutation(async ({ ctx, input }) => {
      const st = await ctx.cards.confirm(input);
      await ctx.deps.db.update(schema.cardOrders).set({ status: st.status, spendTx: input.spendTx }).where(eq(schema.cardOrders.id, input.orderId));
      return st;
    }),
  }),
});

export type AppRouter = typeof appRouter;

export function linkMessage(tgId: number, nonce: string): string {
  return `Link Telegram account ${tgId} to my Cofer key.\nNonce: ${nonce}`;
}
