/**
 * GitHub for the team bot: the repo's releases (drafts included, with the token), publishing a
 * draft at its hour, and CHANGELOG.md on main. The token goes in a header only, never in a URL or
 * a message. Errors are fixed sentences with GitHub's status code.
 */
import type { Release } from "./gate";

export interface GitHub {
  releases(fresh: boolean): Promise<Release[]>;
  publish(id: number): Promise<void>;
  changelog(): Promise<string>;
}

export interface GitHubOptions {
  repo: string;
  token?: string;
  fetch?: typeof fetch;
  now?: () => number;
  api?: string; // default https://api.github.com
  raw?: string; // default https://raw.githubusercontent.com
}

const RELEASES_TTL_MS = 30_000;
const CHANGELOG_TTL_MS = 60_000;

export function githubClient(o: GitHubOptions): GitHub {
  const f = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const api = o.api ?? "https://api.github.com";
  const raw = o.raw ?? "https://raw.githubusercontent.com";
  const headers = () => ({ accept: "application/vnd.github+json", "user-agent": "cofer-teambot", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) });
  let rel: { at: number; list: Release[] } | null = null;
  let cl: { at: number; text: string } | null = null;

  async function get(url: string, init: RequestInit, what: string): Promise<Response> {
    let r: Response;
    try {
      r = await f(url, { ...init, signal: AbortSignal.timeout(15_000) });
    } catch {
      throw new Error(`${what} could not be read (no answer)`);
    }
    if (!r.ok) throw new Error(`${what} could not be read (${r.status})`);
    return r;
  }

  return {
    async releases(fresh) {
      if (!fresh && rel && now() - rel.at < RELEASES_TTL_MS) return rel.list;
      const out: Release[] = [];
      for (let page = 1; page <= 3; page++) {
        const r = await get(`${api}/repos/${o.repo}/releases?per_page=100&page=${page}`, { headers: headers() }, "GitHub releases");
        const j = (await r.json()) as Release[];
        out.push(...j.map((x) => ({ id: x.id, tag_name: x.tag_name, draft: x.draft })));
        if (j.length < 100) break;
      }
      rel = { at: now(), list: out };
      return out;
    },
    async publish(id) {
      let r: Response;
      try {
        r = await f(`${api}/repos/${o.repo}/releases/${id}`, { method: "PATCH", headers: { ...headers(), "content-type": "application/json" }, body: JSON.stringify({ draft: false }), signal: AbortSignal.timeout(15_000) });
      } catch {
        throw new Error("GitHub could not be reached to publish the release");
      }
      if (!r.ok) throw Object.assign(new Error(`GitHub refused (${r.status})`), { status: r.status });
      rel = null; // read again next time
    },
    async changelog() {
      if (cl && now() - cl.at < CHANGELOG_TTL_MS) return cl.text;
      const r = await get(`${raw}/${o.repo}/main/CHANGELOG.md`, { headers: { "cache-control": "no-cache" } }, "CHANGELOG.md");
      cl = { at: now(), text: await r.text() };
      return cl.text;
    },
  };
}
