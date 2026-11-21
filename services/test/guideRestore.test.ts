/** The restore guide (docs/ops/restore.md) names only commands, files and settings that exist. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { backupCommands, fileFor } from "../scripts/ops/backup";

const guide = readFileSync(new URL("../../docs/ops/restore.md", import.meta.url), "utf8");
const commands = [...guide.matchAll(/```bash\n([\s\S]*?)```/g)].flatMap((m) => m[1]!.trim().split("\n").map((l) => l.trim()));

describe("restore guide", () => {
  test("it restores the file the backup makes, with the same tool and options", () => {
    expect(fileFor("2026-12-01")).toBe("cofer-2026-12-01.dump");
    expect(guide).toContain("cofer-YYYY-MM-DD.dump");
    const restore = commands.find((c) => c.startsWith("pg_restore"))!;
    expect(restore.split(" ").slice(0, 2)).toEqual(backupCommands("/b", "d", "s").restore.slice(0, 2));
  });

  test("no connection detail on a command line; the password is typed at a hidden prompt", () => {
    expect(commands.some((c) => /postgres:\/\//.test(c))).toBe(false);
    expect(commands).toContain("read -rs PGPASSWORD && export PGPASSWORD");
  });

  test("the commands it names exist: migrations, status, replay", () => {
    expect(commands).toContain("bunx drizzle-kit migrate");
    const ops = readFileSync(new URL("../scripts/ops/cofer-ops.ts", import.meta.url), "utf8");
    for (const c of ["status", "replay"]) expect(ops).toContain(`${c}: "./${c}.ts"`);
    expect(guide).toContain("events already stored are skipped, never counted twice");
  });
});
