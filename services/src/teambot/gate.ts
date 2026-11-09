/**
 * The gate: what stops an update from going out at its hour, as plain sentences. Empty = ready.
 *   - status VERIFIED, or marked checked from the server (cofer-release verify N)
 *   - both posters on the server
 *   - its changelog line in CHANGELOG.md on main, when its changelog is "add"
 *   - its GitHub release update-NN exists (unless GitHub is off)
 * Reading GitHub is passed in (see github.ts), so this file sends nothing.
 */
import fs from "node:fs";
import { posterPath, tag, type Book, type Shape, type Update } from "./data";
import type { State } from "./state";

export interface Release {
  id: number;
  tag_name: string;
  draft: boolean;
}

export interface GateDeps {
  githubMode: "publish" | "check" | "off";
  /** CHANGELOG.md on main. Throws a plain message when it cannot be read. */
  changelog(): Promise<string>;
  /** Every release (drafts included when the token allows). Throws a plain message when it cannot be read. */
  releases(fresh: boolean): Promise<Release[]>;
  /** Default: the file exists. */
  posterExists?(path: string): boolean;
}

/** How much of the changelog line has to be found (the start of it). */
const CHANGELOG_MATCH = 60;

const sentence = (e: unknown) => {
  const m = e instanceof Error ? e.message : String(e);
  return m.endsWith(".") ? m : `${m}.`;
};

export async function gate(st: State, book: Book, u: Update, deps: GateDeps, fresh = false): Promise<{ why: string[]; rel: Release | null }> {
  const why: string[] = [];
  if (u.status !== "VERIFIED" && !st.u[u.n]?.verified) why.push(`It is marked ${u.status}. Do its one-time check, then run: cofer-release verify ${u.n}.`);
  const exists = deps.posterExists ?? fs.existsSync;
  for (const shape of ["square", "wide"] as Shape[]) if (!exists(posterPath(book, u.n, shape))) why.push(`The ${shape} poster file is missing on the server.`);
  if (u.changelog === "add" && u.changelog_line) {
    try {
      if (!(await deps.changelog()).includes(u.changelog_line.slice(0, CHANGELOG_MATCH))) why.push("Its changelog line is not in CHANGELOG.md on main yet.");
    } catch (e) {
      why.push(sentence(e));
    }
  }
  let rel: Release | null = null;
  if (deps.githubMode !== "off") {
    try {
      rel = (await deps.releases(fresh)).find((r) => r.tag_name === tag(u.n)) ?? null;
      if (!rel) why.push(`The GitHub release ${tag(u.n)} does not exist.`);
    } catch (e) {
      why.push(sentence(e));
    }
  }
  return { why, rel };
}
