/**
 * v2 Arena switches. Every v2 feature is OFF unless switched on, and on mainnet (4663) it stays off until its launch
 * gate in the spec has passed and the owner turns it on there on purpose:
 *   ARENA_FEATURES=practice,app            used on testnet (46630) only
 *   ARENA_FEATURES_MAINNET=practice        the only list read on mainnet (a testnet list never reaches mainnet)
 * Group accounts never read these: nothing in the existing bot, API, keeper or relayer changes when they are off.
 */
export const ARENA_FEATURES = ["app", "practice", "friend", "freeroll", "duel", "boards", "stake", "marks", "engine", "signer", "eligibility"] as const;
export type ArenaFeature = (typeof ARENA_FEATURES)[number];

function list(v: string | undefined): Set<string> {
  return new Set((v ?? "").split(",").map((s) => s.trim()).filter(Boolean));
}

export function arenaEnabled(f: ArenaFeature, env: Record<string, string | undefined> = process.env): boolean {
  const chain = Number(env.CHAIN_ID);
  if (chain === 4663) return list(env.ARENA_FEATURES_MAINNET).has(f);
  if (chain === 46630) return list(env.ARENA_FEATURES).has(f);
  return false; // unknown chain: off
}
