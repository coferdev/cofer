/**
 * cofer-ops verify-release <tag>: checks that what the server serves is byte for byte a fresh build of that public
 * release: the signing scripts (/assets/signer.js, and /assets/wallet.js when Connect wallet is on) and every file of
 * the dashboard site. It clones the public tag into a throwaway folder, builds it, and compares SHA-256 hashes.
 * Read-only. Anyone can do the same: rebuild the tag and compare with the hashes /v1/status lists.
 *   cofer-ops verify-release update-07 [--site https://<signer site>] [--dashboard https://<dashboard site>]
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

export const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

export interface VerifyDeps {
  /** A checkout of the tag in a throwaway folder. */
  checkout(tag: string): Promise<string>;
  /** The fresh build's files: published path -> SHA-256 (signing scripts, and dashboard files under "dashboard:"). */
  build(dir: string): Promise<Record<string, string>>;
  /** What the server serves at that path (null when it does not answer 200). */
  served(path: string): Promise<string | null>;
  cleanup(dir: string): void;
}

export interface Verdict {
  tag: string;
  matched: string[];
  differ: { path: string; built: string; served: string | null }[];
}

export async function verifyRelease(tag: string, d: VerifyDeps): Promise<Verdict> {
  if (!/^[\w.-]{1,64}$/.test(tag)) throw new Error("The tag must be a plain release name, for example update-07.");
  const dir = await d.checkout(tag);
  try {
    const built = await d.build(dir);
    const v: Verdict = { tag, matched: [], differ: [] };
    for (const [path, hash] of Object.entries(built).sort()) {
      const s = await d.served(path);
      if (s === hash) v.matched.push(path);
      else v.differ.push({ path, built: hash, served: s });
    }
    return v;
  } finally {
    d.cleanup(dir);
  }
}

export function verdictText(v: Verdict): string {
  if (!v.differ.length) return `${v.tag}: every served file matches a fresh build of the public release (${v.matched.length} files).`;
  return [`${v.tag}: ${v.differ.length} served file(s) do NOT match a fresh build of the public release:`, ...v.differ.map((x) => `  ${x.path}: built ${x.built.slice(0, 16)}…, served ${x.served ? `${x.served.slice(0, 16)}…` : "nothing (no answer)"}`)].join("\n");
}

/** Every file under a folder, as path -> SHA-256. */
export function hashTree(root: string, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out[`${prefix}/${relative(root, p)}`] = sha256(readFileSync(p));
    }
  };
  walk(root);
  return out;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (k: string) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const tag = argv.find((a) => !a.startsWith("--") && a !== flag("site") && a !== flag("dashboard"));
  if (!tag) {
    console.log("usage: cofer-ops verify-release <tag> [--site https://<signer site>] [--dashboard https://<dashboard site>]");
    process.exit(2);
  }
  const site = (flag("site") ?? process.env.PUBLIC_URL ?? "").replace(/\/$/, "");
  const dashboard = (flag("dashboard") ?? process.env.DASHBOARD_URL ?? "").replace(/\/$/, "");
  const walletOn = !!process.env.REOWN_PROJECT_ID;
  const sh = (cmd: string[], cwd: string) => {
    const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    if (r.exitCode !== 0) throw new Error(`${cmd.slice(0, 3).join(" ")} failed: ${r.stderr.toString().split("\n")[0]}`);
    return r.stdout.toString();
  };
  const v = await verifyRelease(tag, {
    async checkout(t) {
      const dir = mkdtempSync(join(tmpdir(), "cofer-verify-"));
      sh(["git", "clone", "-q", "--depth", "1", "--branch", t, "https://github.com/coferdev/cofer.git", dir], tmpdir());
      return dir;
    },
    async build(dir) {
      sh(["bun", "install", "--frozen-lockfile"], join(dir, "services"));
      const out = JSON.parse(sh(["bun", "-e", `const s = await import("./src/api/server.ts"); const h = (x) => new Bun.CryptoHasher("sha256").update(x).digest("hex"); console.log(JSON.stringify({ signer: h(await s.buildSignerBundle()), wallet: ${walletOn} ? h(await s.buildWalletBundle()) : null }))`], join(dir, "services")).trim().split("\n").at(-1)!) as { signer: string; wallet: string | null };
      const files: Record<string, string> = { "/assets/signer.js": out.signer };
      if (out.wallet) files["/assets/wallet.js"] = out.wallet;
      if (dashboard) {
        sh(["npm", "ci", "--no-audit"], join(dir, "site"));
        sh(["npm", "run", "build:dashboard"], join(dir, "site"));
        for (const [p, h] of Object.entries(hashTree(join(dir, "site", "dashboard-dist"), "dashboard:"))) files[p] = h;
      }
      return files;
    },
    async served(path) {
      const url = path.startsWith("dashboard:") ? `${dashboard}${path.slice("dashboard:".length)}` : `${site}${path}`;
      const r = await fetch(url).catch(() => null);
      return r && r.status === 200 ? sha256(new Uint8Array(await r.arrayBuffer())) : null;
    },
    cleanup: (dir) => rmSync(dir, { recursive: true, force: true }),
  });
  console.log(verdictText(v));
  process.exit(v.differ.length ? 1 : 0);
}
