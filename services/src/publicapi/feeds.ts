/**
 * GET /v1/pots/:pot/feed.atom and /feed.json: one group account's own feed (Atom 1.0 and JSON Feed 1.1): each new
 * deposit, exit, vote (queued or run) and allowance spend, newest first, from the indexer's copy of its logs, in the
 * same plain words as the transaction explainer. Read-only: nothing is stored about who subscribes. Item ids are
 * fixed by transaction and log, so a reader never shows one twice.
 */
import type { Address } from "viem";
import { describeEvent, type ExplainDeps } from "../core/txExplain";
import type { EventRow } from "./timeline";

export const POT_FEED_EVENTS = ["Deposited", "Exited", "ProposalQueued", "ProposalExecuted", "AllowanceSpent"];
export const POT_FEED_SIZE = 50;
export const POT_FEED_CACHE_MS = 60_000;

export interface PotFeedDeps {
  /** The newest of these events for this pot, newest first. */
  latest(pot: Address, names: string[], limit: number): Promise<EventRow[]>;
  blockTime(n: bigint): Promise<number>;
  explain: Pick<ExplainDeps, "token" | "usdg">;
  baseUrl: string;
}

export interface PotFeedItem {
  id: string;
  title: string;
  text: string;
  url: string;
  time: string; // ISO
}

const TITLES: Record<string, string> = { deposit: "Deposit", exit: "Exit", "vote queued": "Vote passed, waiting for its exit window", "vote executed": "Vote ran", "allowance spend": "Allowance spend" };

export async function potFeedItems(d: PotFeedDeps, pot: Address): Promise<PotFeedItem[]> {
  const rows = await d.latest(pot, POT_FEED_EVENTS, POT_FEED_SIZE);
  const out: PotFeedItem[] = [];
  const times = new Map<bigint, number>();
  for (const r of rows) {
    const desc = await describeEvent("group account", r.name, r.args, pot, d.explain);
    if (!desc) continue;
    if (!times.has(r.block)) times.set(r.block, await d.blockTime(r.block).catch(() => 0));
    out.push({
      id: `tag:getcofer.com,2026:pot:${pot.toLowerCase()}:${r.txHash.toLowerCase()}:${r.logIndex}`,
      title: TITLES[desc.kind] ?? desc.kind,
      text: desc.text,
      url: `${d.baseUrl.replace(/\/$/, "")}/tx/${r.txHash}`,
      time: new Date((times.get(r.block) ?? 0) * 1000).toISOString(),
    });
  }
  return out;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function potAtom(items: PotFeedItem[], pot: Address, base: string): string {
  const b = base.replace(/\/$/, "");
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `<id>tag:getcofer.com,2026:pot:${pot.toLowerCase()}</id>`,
    `<title>Cofer group account ${pot}</title>`,
    `<updated>${items[0]?.time ?? "2026-10-31T00:00:00.000Z"}</updated>`,
    `<link rel="self" type="application/atom+xml" href="${xml(`${b}/v1/pots/${pot}/feed.atom`)}"/>`,
    "<author><name>Cofer</name></author>",
    ...items.map((i) => `<entry><id>${xml(i.id)}</id><title>${xml(i.title)}</title><updated>${i.time}</updated><link rel="alternate" type="text/html" href="${xml(i.url)}"/><content type="text">${xml(i.text)}</content></entry>`),
    "</feed>",
  ].join("\n");
}

export function potJsonFeed(items: PotFeedItem[], pot: Address, base: string) {
  const b = base.replace(/\/$/, "");
  return { version: "https://jsonfeed.org/version/1.1", title: `Cofer group account ${pot}`, feed_url: `${b}/v1/pots/${pot}/feed.json`, items: items.map((i) => ({ id: i.id, url: i.url, title: i.title, content_text: i.text, date_published: i.time })) };
}
