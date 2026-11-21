/**
 * The public API, mounted at /v1 on the signer server (owner's decision: no separate address). Read-only: GET only,
 * no sign-in, no keys, per-IP rate limited (rateLimit.ts), CORS open for GET. Only on-chain data, never anything
 * from Telegram. A failed chain or database read answers 503 with fixed text; the error is logged without URLs.
 */
import { Hono, type Context } from "hono";
import { logError } from "../core/errors";
import { badgeSvg, type BadgeState } from "./badge";
import { cached, fail, ok, PUBLIC_HEADERS } from "./format";
import { clientKey, limiter, type Limiter } from "./rateLimit";
import { readStatus, STATUS_CACHE_MS, type Status, type StatusDeps } from "./status";
import { isTxHash, TX_CACHE_SECONDS, txExplainer, type TxDeps } from "./tx";
import { OWNERSHIP_CACHE_MS, readOwnership, type Ownership, type OwnershipDeps } from "./ownership";
import { atomFeed, FEED_CACHE_SECONDS, jsonFeed, parseChangelog } from "./changelog";
import { limitParam, MEMBERS_CACHE_MS, MEMBERS_DEFAULT_LIMIT, MEMBERS_MAX_LIMIT, readKeyGroups, readMembers, type KeyGroupsDeps, type MembersDeps, type MembersPage } from "./members";
import { readVotes, stateParam, VOTES_CACHE_MS, VOTES_MAX_LIMIT, type PublicVote, type VotesDeps } from "./votes";
import { afterParam, readTimeline, TIMELINE_CACHE_MS, TIMELINE_MAX_LIMIT, type TimelineDeps, type TimelinePage } from "./timeline";
import { RECEIPT_CACHE_SECONDS, receiptMaker, type ReceiptKind, type ReceiptsDeps } from "./receipts";
import { voteReceipt, type VoteReceipt, type VoteReceiptDeps } from "../core/voteReceipt";
import { readSetAsides, SET_ASIDES_CACHE_MS, type SetAsidesDeps } from "./setAsides";
import { ADMIN_CACHE_MS, readAdminPending, type AdminDeps } from "./admin";
import { HOLDINGS_CACHE_MS, rangeParams, readHoldings, type HoldingsDeps } from "./holdings";
import { blockParam, readSnapshotProof, type SnapshotProofDeps } from "./snapshotProof";
import { FEES_CACHE_MS, FEES_MAX_LIMIT, readFees, type FeesDeps } from "./fees";
import { openApiSpec } from "./openapi";
import { llmsText } from "./llms";
import { potAtom, POT_FEED_CACHE_MS, potFeedItems, potJsonFeed, type PotFeedDeps } from "./feeds";
import { perKeyCache, POT_CACHE_MS, POT_CACHE_SIZE, potParam, readPotSummary, type PotsDeps, type PotSummary } from "./pots";

export interface PublicApiDeps {
  chainId: number;
  status: StatusDeps;
  tx: TxDeps;
  ownership: OwnershipDeps;
  /** CHANGELOG.md as it is in this release, and the public address the feeds name as their own. */
  changelog: { text: string; baseUrl: string };
  pots: PotsDeps;
  members: MembersDeps;
  keyGroups: KeyGroupsDeps;
  setAsides: SetAsidesDeps;
  admin: AdminDeps;
  holdings: HoldingsDeps;
  snapshotProof: SnapshotProofDeps;
  fees: FeesDeps;
  potFeeds: PotFeedDeps;
  votes: VotesDeps;
  timeline: TimelineDeps;
  receipts: ReceiptsDeps;
  voteReceipts: VoteReceiptDeps;
  limiter?: Limiter;
  nowMs?: () => number;
  /** SHA-256 of the scripts this server serves (filled in by the server), listed in /v1/status. */
  bundles?: { signerJs: string; walletJs: string | null };
}

export const TEXT = {
  notFound: "Not found. The public API is read-only; see docs/api/README.md for its routes.",
  method: "Only GET is allowed.",
  limited: "Too many requests. Wait a little and try again.",
  down: "Couldn't read the chain or the database just now. Try again in a minute.",
  badHash: "A transaction hash is 0x followed by 64 hex characters.",
  badPot: "A group account address is 0x followed by 40 hex characters.",
  noPot: "No Cofer group account at this address.",
  badLimit: "limit must be a whole number from 1 to 200.",
  badAfter: "after must be a member address from the previous page's next.",
  badState: "state must be one of open, ready, queued, executed, expired, stale, failed.",
  badVoteLimit: "limit must be a whole number from 1 to 100.",
  noAction: (k: string) => `This transaction has no Cofer ${k === "spend" ? "allowance spend" : k}.`,
  badDigest: "A vote id is 0x followed by 64 hex characters.",
  noVote: "No vote with this id is known to the API. Votes made outside the bot are listed at /v1/pots/:pot/votes with their transaction.",
  badAddress: "An address is 0x followed by 40 hex characters.",
  badBlock: "block must be a block number.",
  futureBlock: (h: bigint) => `That block is not on the chain yet (newest: ${h}).`,
  badCursor: "after must be the next value of the previous page, like 153947820-4.",
  noTx: "No transaction with this hash on this chain (yet).",
} as const;

export function publicApi(d: PublicApiDeps) {
  const nowMs = d.nowMs ?? Date.now;
  const lim = d.limiter ?? limiter();
  const status = cached<Status>(() => readStatus(d.status), STATUS_CACHE_MS, nowMs);
  const explainTx = txExplainer(d.tx);
  const ownership = cached<Ownership>(() => readOwnership(d.ownership), OWNERSHIP_CACHE_MS, nowMs);
  // a group account must be one the factory made; the answer never changes, so it is kept
  const potKnown = perKeyCache(async (a) => d.pots.isPot(a as `0x${string}`), 24 * 3600_000, 20_000, nowMs);
  const summary = perKeyCache<PotSummary>((a) => readPotSummary(d.pots, a as `0x${string}`), POT_CACHE_MS, POT_CACHE_SIZE, nowMs);
  /** The checked pot address, or the error answer. */
  const pot = async (c: Context) => {
    const a = potParam(c.req.param("pot") ?? "");
    if (!a) return { res: fail(c, 400, "bad_request", TEXT.badPot) };
    if (!(await potKnown(a)).value) return { res: fail(c, 404, "not_found", TEXT.noPot) };
    return { a };
  };

  const membersPage = perKeyCache<MembersPage>(
    (k) => {
      const [a, after, limit] = k.split("|");
      return readMembers(d.members, a as `0x${string}`, after || null, Number(limit));
    },
    MEMBERS_CACHE_MS,
    POT_CACHE_SIZE,
    nowMs,
  );

  const votesList = perKeyCache<PublicVote[]>(
    async (k) => {
      const [a, st, limit] = k.split("|");
      const need = (await summary(a!)).value.voteRule.approvalsNeeded;
      return readVotes(d.votes, a as `0x${string}`, (st || null) as never, Number(limit), need);
    },
    VOTES_CACHE_MS,
    POT_CACHE_SIZE,
    nowMs,
  );

  const timelinePage = perKeyCache<TimelinePage>(
    (k) => {
      const [a, after, limit] = k.split("|");
      const c = afterParam(after);
      return readTimeline(d.timeline, a as `0x${string}`, c === "bad" ? null : c, Number(limit));
    },
    TIMELINE_CACHE_MS,
    POT_CACHE_SIZE,
    nowMs,
  );

  const makeReceipt = receiptMaker(d.receipts);
  const receiptRoute = (kind: ReceiptKind) => async (c: Context) => {
    const hash = c.req.param("tx") ?? "";
    if (!isTxHash(hash)) return fail(c, 400, "bad_request", TEXT.badHash);
    const r = await makeReceipt(kind, hash);
    if (r === null) return fail(c, 404, "not_found", TEXT.noTx);
    if (r === "none") return fail(c, 404, "not_found", TEXT.noAction(kind));
    return ok(c, r, meta(nowMs(), RECEIPT_CACHE_SECONDS));
  };

  // approvals can still change, so a vote receipt is kept only briefly
  const voteReceipts = perKeyCache<VoteReceipt | null>((k) => voteReceipt(k as `0x${string}`, d.voteReceipts), 15_000, POT_CACHE_SIZE, nowMs);

  const keyGroups = perKeyCache((a) => readKeyGroups(d.keyGroups, a as `0x${string}`), MEMBERS_CACHE_MS, POT_CACHE_SIZE, nowMs);

  const setAsides = perKeyCache((a) => readSetAsides(d.setAsides, a as `0x${string}`), SET_ASIDES_CACHE_MS, POT_CACHE_SIZE, nowMs);

  const adminPending = cached(() => readAdminPending(d.admin), ADMIN_CACHE_MS, nowMs);

  const holdings = perKeyCache(
    (k) => {
      const [a, f, t] = k.split("|");
      return readHoldings(d.holdings, a as `0x${string}`, f!, t!);
    },
    HOLDINGS_CACHE_MS,
    POT_CACHE_SIZE,
    nowMs,
  );

  // a past block never changes: kept; the default block moves, so it is read again after 15 seconds
  const snapshots = perKeyCache(
    (k) => {
      const [a, b] = k.split("|");
      return readSnapshotProof(d.snapshotProof, a as `0x${string}`, b ? BigInt(b) : null);
    },
    15_000,
    POT_CACHE_SIZE,
    nowMs,
  );

  const feesPage = perKeyCache(
    (k) => {
      const [a, after, limit] = k.split("|");
      const c = afterParam(after);
      return readFees(d.fees, a as `0x${string}`, c === "bad" ? null : c, Number(limit));
    },
    FEES_CACHE_MS,
    POT_CACHE_SIZE,
    nowMs,
  );

  const potFeed = perKeyCache((a) => potFeedItems(d.potFeeds, a as `0x${string}`), POT_FEED_CACHE_MS, POT_CACHE_SIZE, nowMs);

  // made once at start-up from this release's CHANGELOG.md
  const entries = parseChangelog(d.changelog.text);
  const atom = atomFeed(entries, d.changelog.baseUrl);
  const feedJson = JSON.stringify(jsonFeed(entries, d.changelog.baseUrl));
  /** 0 when this client may make a request now, else the milliseconds to wait (shared by /v1 and the /tx page). */
  const limit = (forwardedFor: string | undefined) => lim.take(clientKey(forwardedFor), nowMs());
  const meta = (at: number, cacheSeconds: number) => ({ chainId: d.chainId, generatedAt: new Date(at).toISOString(), cacheSeconds });
  const app = new Hono();

  app.onError((err, c) => {
    logError("publicapi", err);
    return fail(c, 503, "unavailable", TEXT.down);
  });

  /** Public API answers since start, by status (for the server-only /metrics). */
  const requests: Record<string, number> = {};
  app.use("*", async (c, next) => {
    await next();
    requests[String(c.res.status)] = (requests[String(c.res.status)] ?? 0) + 1;
  });

  app.use("*", async (c, next) => {
    if (c.req.method === "OPTIONS") return c.body(null, 204, PUBLIC_HEADERS);
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return fail(c, 405, "method_not_allowed", TEXT.method, { allow: "GET, OPTIONS" });
    const wait = limit(c.req.header("x-forwarded-for"));
    if (wait > 0) return fail(c, 429, "rate_limited", TEXT.limited, { "retry-after": String(Math.ceil(wait / 1000)) });
    await next();
  });

  app.get("/status", async (c) => {
    const s = await status();
    return ok(c, { ...s.value, bundles: d.bundles ?? null }, meta(s.at, STATUS_CACHE_MS / 1000));
  });

  // a status image for READMEs: never an error image; when the chain cannot be read it says "unknown"
  app.get("/badge.svg", async (c) => {
    let state: BadgeState = "unknown";
    try {
      state = (await status()).value.indexer.state;
    } catch (e) {
      logError("publicapi badge", e);
    }
    return c.body(badgeSvg(d.chainId, state), 200, { ...PUBLIC_HEADERS, "content-type": "image/svg+xml; charset=utf-8", "cache-control": `public, max-age=${STATUS_CACHE_MS / 1000}`, "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" });
  });

  app.get("/tx/:hash", async (c) => {
    const hash = c.req.param("hash");
    if (!isTxHash(hash)) return fail(c, 400, "bad_request", TEXT.badHash);
    const e = await explainTx(hash);
    if (!e) return fail(c, 404, "not_found", TEXT.noTx);
    return ok(c, e, meta(nowMs(), TX_CACHE_SECONDS));
  });

  app.get("/proof/ownership", async (c) => {
    const o = await ownership();
    return ok(c, o.value, meta(o.at, OWNERSHIP_CACHE_MS / 1000));
  });

  app.get("/changelog.atom", (c) => c.body(atom, 200, { ...PUBLIC_HEADERS, "content-type": "application/atom+xml; charset=utf-8", "cache-control": `public, max-age=${FEED_CACHE_SECONDS}` }));
  app.get("/changelog.json", (c) => c.body(feedJson, 200, { ...PUBLIC_HEADERS, "content-type": "application/feed+json; charset=utf-8", "cache-control": `public, max-age=${FEED_CACHE_SECONDS}` }));

  app.get("/pots/:pot", async (c) => {
    const p = await pot(c);
    if (!p.a) return p.res;
    const s = await summary(p.a);
    return ok(c, s.value, meta(s.at, POT_CACHE_MS / 1000));
  });

  app.get("/pots/:pot/members", async (c) => {
    const p = await pot(c);
    if (!p.a) return p.res;
    const limit = limitParam(c.req.query("limit"), MEMBERS_DEFAULT_LIMIT, MEMBERS_MAX_LIMIT);
    if (limit === null) return fail(c, 400, "bad_request", TEXT.badLimit);
    const after = c.req.query("after") ?? "";
    if (after && !potParam(after)) return fail(c, 400, "bad_request", TEXT.badAfter);
    const m = await membersPage(`${p.a}|${after.toLowerCase()}|${limit}`);
    return ok(c, m.value, meta(m.at, MEMBERS_CACHE_MS / 1000));
  });

  app.get("/pots/:pot/votes", async (c) => {
    const p = await pot(c);
    if (!p.a) return p.res;
    const st = stateParam(c.req.query("state"));
    if (st === "bad") return fail(c, 400, "bad_request", TEXT.badState);
    const limit = limitParam(c.req.query("limit"), 50, VOTES_MAX_LIMIT);
    if (limit === null) return fail(c, 400, "bad_request", TEXT.badVoteLimit);
    const v = await votesList(`${p.a}|${st ?? ""}|${limit}`);
    return ok(c, { votes: v.value }, meta(v.at, VOTES_CACHE_MS / 1000));
  });

  app.get("/pots/:pot/timeline", async (c) => {
    const p = await pot(c);
    if (!p.a) return p.res;
    const after = c.req.query("after") ?? "";
    if (afterParam(after) === "bad") return fail(c, 400, "bad_request", TEXT.badCursor);
    const limit = limitParam(c.req.query("limit"), 50, TIMELINE_MAX_LIMIT);
    if (limit === null) return fail(c, 400, "bad_request", TEXT.badLimit);
    const t = await timelinePage(`${p.a}|${after}|${limit}`);
    return ok(c, t.value, meta(t.at, TIMELINE_CACHE_MS / 1000));
  });

  app.get("/receipts/exit/:tx", receiptRoute("exit"));
  app.get("/receipts/deposit/:tx", receiptRoute("deposit"));
  app.get("/receipts/spend/:tx", receiptRoute("spend"));

  app.get("/receipts/vote/:digest", async (c) => {
    const digest = c.req.param("digest");
    if (!isTxHash(digest)) return fail(c, 400, "bad_request", TEXT.badDigest);
    const v = await voteReceipts(digest.toLowerCase());
    if (!v.value) return fail(c, 404, "not_found", TEXT.noVote);
    return ok(c, v.value, meta(v.at, 15));
  });

  app.get("/members/:address", async (c) => {
    const a = potParam(c.req.param("address"));
    if (!a) return fail(c, 400, "bad_request", TEXT.badAddress);
    const g = await keyGroups(a);
    return ok(c, g.value, meta(g.at, MEMBERS_CACHE_MS / 1000));
  });

  app.get("/set-asides/:address", async (c) => {
    const a = potParam(c.req.param("address"));
    if (!a) return fail(c, 400, "bad_request", TEXT.badAddress);
    const r = await setAsides(a);
    return ok(c, r.value, meta(r.at, SET_ASIDES_CACHE_MS / 1000));
  });

  app.get("/admin/pending", async (c) => {
    const r = await adminPending();
    return ok(c, r.value, meta(r.at, ADMIN_CACHE_MS / 1000));
  });

  app.get("/pots/:pot/holdings", async (c) => {
    const p = await pot(c);
    if (!p.a) return p.res;
    const r = rangeParams(c.req.query("from"), c.req.query("to"), d.holdings.now());
    if ("why" in r) return fail(c, 400, "bad_request", r.why);
    const h = await holdings(`${p.a}|${r.from}|${r.to}`);
    return ok(c, h.value, meta(h.at, HOLDINGS_CACHE_MS / 1000));
  });

  app.get("/proof/snapshot/:pot", async (c) => {
    const p = await pot(c);
    if (!p.a) return p.res;
    const b = blockParam(c.req.query("block"));
    if (b === "bad") return fail(c, 400, "bad_request", TEXT.badBlock);
    const r = await snapshots(`${p.a}|${b ?? ""}`);
    if ("tooNew" in r.value) return fail(c, 400, "bad_request", TEXT.futureBlock((r.value as { head: bigint }).head));
    return ok(c, r.value, meta(r.at, b === null ? 15 : 3600));
  });

  app.get("/pots/:pot/fees", async (c) => {
    const p = await pot(c);
    if (!p.a) return p.res;
    const after = c.req.query("after") ?? "";
    if (afterParam(after) === "bad") return fail(c, 400, "bad_request", TEXT.badCursor);
    const limit = limitParam(c.req.query("limit"), 50, FEES_MAX_LIMIT);
    if (limit === null) return fail(c, 400, "bad_request", TEXT.badLimit);
    const f = await feesPage(`${p.a}|${after}|${limit}`);
    return ok(c, f.value, meta(f.at, FEES_CACHE_MS / 1000));
  });

  const spec = JSON.stringify(openApiSpec(d.changelog.baseUrl, "1"));
  app.get("/openapi.json", (c) => c.body(spec, 200, { ...PUBLIC_HEADERS, "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=3600" }));

  const llms = llmsText(d.changelog.baseUrl);
  app.get("/llms.txt", (c) => c.body(llms, 200, { ...PUBLIC_HEADERS, "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" }));

  app.get("/pots/:pot/feed.atom", async (c) => {
    const p = await pot(c);
    if (!p.a) return p.res;
    const items = (await potFeed(p.a)).value;
    return c.body(potAtom(items, p.a, d.potFeeds.baseUrl), 200, { ...PUBLIC_HEADERS, "content-type": "application/atom+xml; charset=utf-8", "cache-control": `public, max-age=${POT_FEED_CACHE_MS / 1000}` });
  });
  app.get("/pots/:pot/feed.json", async (c) => {
    const p = await pot(c);
    if (!p.a) return p.res;
    const items = (await potFeed(p.a)).value;
    return c.body(JSON.stringify(potJsonFeed(items, p.a, d.potFeeds.baseUrl)), 200, { ...PUBLIC_HEADERS, "content-type": "application/feed+json; charset=utf-8", "cache-control": `public, max-age=${POT_FEED_CACHE_MS / 1000}` });
  });

  // last: anything else under /v1 (a sub-app's notFound is not used once it is mounted)
  app.all("*", (c) => fail(c, 404, "not_found", TEXT.notFound));
  return { app, status, explainTx, limit, llms, requests };
}
