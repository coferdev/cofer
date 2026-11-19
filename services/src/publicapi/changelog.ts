/**
 * GET /v1/changelog.atom and /v1/changelog.json: Cofer's CHANGELOG.md as a feed (Atom 1.0 and JSON Feed 1.1), made
 * once when the server starts from the CHANGELOG.md in its own release folder. Entries, newest first:
 *   - each tech update line, "- Update NN · YYYY-MM-DD HH:MM UTC: Title: what is new", linking its GitHub release;
 *   - each released version, "## [x.y.z] - YYYY-MM-DD", with its section text.
 * The "Unreleased" section's other text is not an entry (it has no date yet).
 */

export const REPO = "https://github.com/coferdev/cofer";
export const RELEASE_TAG_PREFIX = "update-";
export const FEED_MAX_ENTRIES = 100;
export const FEED_CACHE_SECONDS = 300;

export interface FeedEntry {
  id: string;
  title: string;
  url: string;
  updated: string; // ISO
  text: string;
}

const TECH = /^- Update (\d{2}) · (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC: (.+)$/;
const VERSION = /^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})\s*$/;

export function parseChangelog(md: string): FeedEntry[] {
  const lines = md.split("\n");
  const out: FeedEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = TECH.exec(lines[i]!);
    if (t) {
      const [, nn, day, time, text] = t;
      const name = text!.split(": ")[0]!;
      out.push({ id: `tag:getcofer.com,2026:${RELEASE_TAG_PREFIX}${nn}`, title: `Update ${nn}: ${name}`, url: `${REPO}/releases/tag/${RELEASE_TAG_PREFIX}${nn}`, updated: `${day}T${time}:00Z`, text: text! });
      continue;
    }
    const v = VERSION.exec(lines[i]!);
    if (v) {
      let j = i + 1;
      while (j < lines.length && !lines[j]!.startsWith("## ")) j++;
      out.push({ id: `tag:getcofer.com,2026:v${v[1]}`, title: `Cofer ${v[1]}`, url: `${REPO}/blob/main/CHANGELOG.md`, updated: `${v[2]}T00:00:00Z`, text: lines.slice(i + 1, j).join("\n").trim() });
    }
  }
  return out.sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : b.id.localeCompare(a.id))).slice(0, FEED_MAX_ENTRIES);
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

export function atomFeed(entries: FeedEntry[], base: string): string {
  const self = `${base.replace(/\/$/, "")}/v1/changelog.atom`;
  const updated = entries[0]?.updated ?? "2026-10-31T00:00:00Z";
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    "<id>tag:getcofer.com,2026:changelog</id>",
    "<title>Cofer changelog</title>",
    `<updated>${updated}</updated>`,
    `<link rel="self" type="application/atom+xml" href="${xml(self)}"/>`,
    `<link rel="alternate" type="text/html" href="${REPO}/blob/main/CHANGELOG.md"/>`,
    "<author><name>Cofer</name></author>",
    ...entries.map((e) => `<entry><id>${xml(e.id)}</id><title>${xml(e.title)}</title><updated>${e.updated}</updated><link rel="alternate" type="text/html" href="${xml(e.url)}"/><content type="text">${xml(e.text)}</content></entry>`),
    "</feed>",
  ].join("\n");
}

export function jsonFeed(entries: FeedEntry[], base: string) {
  return {
    version: "https://jsonfeed.org/version/1.1",
    title: "Cofer changelog",
    home_page_url: `${REPO}/blob/main/CHANGELOG.md`,
    feed_url: `${base.replace(/\/$/, "")}/v1/changelog.json`,
    items: entries.map((e) => ({ id: e.id, url: e.url, title: e.title, content_text: e.text, date_published: e.updated })),
  };
}
