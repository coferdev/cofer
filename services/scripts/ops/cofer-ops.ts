#!/usr/bin/env bun
/**
 * cofer-ops: server commands for the people who run Cofer. Each one only reads, unless its own help says otherwise.
 *   cofer-ops status [--units cofer,cofer-mainnet] [--releases /srv/cofer-releases/testnet]
 * On the server it is a shortcut for: bun /path/to/current/services/scripts/ops/cofer-ops.ts
 */
const COMMANDS: Record<string, string> = { status: "./status.ts" };

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  const file = cmd ? COMMANDS[cmd] : undefined;
  if (!file) {
    console.log(`usage: cofer-ops ${Object.keys(COMMANDS).join(" | ")} [options]`);
    process.exit(2);
  }
  const r = Bun.spawnSync(["bun", new URL(file, import.meta.url).pathname, ...rest], { stdout: "inherit", stderr: "inherit", env: process.env });
  process.exit(r.exitCode ?? 1);
}
