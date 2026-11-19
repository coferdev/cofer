#!/usr/bin/env bun
/**
 * cofer: read-only command line for Cofer. It never signs and never sends a transaction.
 *   bun sdk/bin/cofer.ts verify <receipt.json> [--rpc <url>]   check a receipt from /v1/receipts/... against the chain
 * Default RPC: Robinhood Chain mainnet's public RPC (testnet: --rpc https://rpc.testnet.chain.robinhood.com).
 */
import { readFileSync } from "node:fs";
import { verdictText, verifyReceipt, type ChainReader } from "../src/verify";

export const MAINNET_RPC = "https://rpc.mainnet.chain.robinhood.com";

export async function main(argv: string[], out: (s: string) => void = console.log, reader?: ChainReader): Promise<number> {
  const [cmd, ...rest] = argv;
  const flag = (name: string, def: string) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? (rest[i + 1] ?? def) : def;
  };
  if (cmd === "verify") {
    const file = rest.find((a) => !a.startsWith("--") && a !== flag("rpc", ""));
    if (!file) {
      out("usage: cofer verify <receipt.json> [--rpc <url>]");
      return 2;
    }
    const receipt = JSON.parse(readFileSync(file, "utf8"));
    const v = await verifyReceipt(receipt, reader ?? flag("rpc", MAINNET_RPC));
    out(verdictText(v));
    return v.ok ? 0 : 1;
  }
  out("usage: cofer verify <receipt.json> [--rpc <url>]");
  return 2;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
