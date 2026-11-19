/**
 * GET /v1/badge.svg: a small status image for any README or page. Left: "cofer · chain 4663". Right: the indexer's
 * state from /v1/status (live, behind, not started), or "unknown" when the chain cannot be read just then.
 * Plain SVG: fixed shapes and escaped text only, no script, no event attribute, no outside reference.
 */
import type { IndexerState } from "./status";

export type BadgeState = IndexerState | "unknown";

const COLORS: Record<BadgeState, string> = { live: "#2e9e5b", behind: "#c98a16", "not started": "#8b8b8e", unknown: "#8b8b8e" };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** About 6.5 px per character at 11 px, plus padding. */
const width = (s: string) => Math.round(s.length * 6.5) + 14;

export function badgeSvg(chainId: number, state: BadgeState): string {
  const left = `cofer · chain ${chainId}`;
  const right = `indexer ${state}`;
  const lw = width(left);
  const rw = width(right);
  const w = lw + rw;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${esc(`${left}: ${right}`)}">`,
    `<title>${esc(`${left}: ${right}`)}</title>`,
    `<rect width="${lw}" height="20" rx="3" fill="#1c1c1e"/>`,
    `<rect x="${lw}" width="${rw}" height="20" rx="3" fill="${COLORS[state]}"/>`,
    `<rect x="${lw}" width="4" height="20" fill="${COLORS[state]}"/>`,
    `<g fill="#ffffff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11">`,
    `<text x="${lw / 2}" y="14" text-anchor="middle">${esc(left)}</text>`,
    `<text x="${lw + rw / 2}" y="14" text-anchor="middle">${esc(right)}</text>`,
    `</g></svg>`,
  ].join("");
}

/** The snippet to paste into a README (Markdown) or a page (HTML). */
export function embedSnippets(base: string): { markdown: string; html: string } {
  const url = `${base.replace(/\/$/, "")}/v1/badge.svg`;
  return { markdown: `![Cofer status](${url})`, html: `<img src="${url}" alt="Cofer status" height="20">` };
}
