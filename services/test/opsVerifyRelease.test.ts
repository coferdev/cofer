import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashTree, sha256, verdictText, verifyRelease, type VerifyDeps } from "../scripts/ops/verifyRelease";

/** A local git repo with a tag, whose "build" is its files (a stand-in for the real bundle build). */
function fixture() {
  const repo = mkdtempSync(join(tmpdir(), "vr-repo-"));
  const run = (cmd: string[]) => Bun.spawnSync(cmd, { cwd: repo });
  run(["git", "init", "-q", "-b", "main"]);
  mkdirSync(join(repo, "dist", "dashboard"), { recursive: true });
  writeFileSync(join(repo, "dist", "signer.js"), "console.log('signer v1')");
  writeFileSync(join(repo, "dist", "dashboard", "index.html"), "<html>v1</html>");
  run(["git", "add", "-A"]);
  run(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "v1"]);
  run(["git", "tag", "update-07"]);
  return repo;
}

function deps(repo: string, served: Record<string, string>): VerifyDeps & { cleaned: string[] } {
  const cleaned: string[] = [];
  return {
    cleaned,
    async checkout(tag) {
      const dir = mkdtempSync(join(tmpdir(), "vr-co-"));
      const r = Bun.spawnSync(["git", "clone", "-q", "--branch", tag, repo, dir]);
      if (r.exitCode !== 0) throw new Error("no such tag");
      return dir;
    },
    async build(dir) {
      return { "/assets/signer.js": sha256(await Bun.file(join(dir, "dist", "signer.js")).text()), ...hashTree(join(dir, "dist", "dashboard"), "dashboard:") };
    },
    served: async (p) => (p in served ? sha256(served[p]!) : null),
    cleanup: (dir) => void cleaned.push(dir),
  };
}

describe("cofer-ops verify-release", () => {
  test("a server serving exactly the tag's build: every file matches", async () => {
    const repo = fixture();
    const d = deps(repo, { "/assets/signer.js": "console.log('signer v1')", "dashboard:/index.html": "<html>v1</html>" });
    const v = await verifyRelease("update-07", d);
    expect(v.differ).toEqual([]);
    expect(verdictText(v)).toBe("update-07: every served file matches a fresh build of the public release (2 files).");
    expect(d.cleaned).toHaveLength(1);
  });

  test("a changed script or a missing dashboard file is named", async () => {
    const repo = fixture();
    const v = await verifyRelease("update-07", deps(repo, { "/assets/signer.js": "console.log('signer CHANGED')" }));
    expect(v.differ.map((x) => x.path)).toEqual(["/assets/signer.js", "dashboard:/index.html"]);
    expect(verdictText(v)).toContain("2 served file(s) do NOT match");
    expect(verdictText(v)).toContain("dashboard:/index.html: built");
    expect(verdictText(v)).toContain("served nothing (no answer)");
  });

  test("only plain tag names are accepted", async () => {
    await expect(verifyRelease("update-07; rm -rf /", deps(fixture(), {}))).rejects.toThrow("plain release name");
    expect(existsSync("/")).toBe(true);
  });
});
