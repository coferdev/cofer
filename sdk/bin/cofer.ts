#!/usr/bin/env bun
/**
 * cofer: read-only command line for Cofer. It never signs and never sends a transaction (it holds no key at all).
 *   cofer pot <group address>              a group: members, vote rule, exit window, tokens        (public API)
 *   cofer member <address>                 every group where an address is an active member       (public API)
 *   cofer exit-check <group> <address>     what that member's full exit would pay right now       (the chain)
 *   cofer tx <hash>                        any transaction in plain words                          (public API)
 *   cofer verify <receipt.json>            check a receipt from /v1/receipts/... against the chain (the chain)
 * Options: --api <signer site> (or COFER_API), --rpc <url> (default: Robinhood Chain mainnet's public RPC).
 *   bun sdk/bin/cofer.ts pot 0x… --api https://<signer site>
 */
import { readFileSync } from "node:fs";
import { createPublicClient, formatUnits, getAddress, http, isAddress, type PublicClient } from "viem";
import { createCoferClient } from "../src/client";
import { buildExit, EXIT_ABI } from "../src/exit";
import { verdictText, verifyReceipt, type ChainReader } from "../src/verify";

export const MAINNET_RPC = "https://rpc.mainnet.chain.robinhood.com";
const USAGE = "usage: cofer pot <group> | member <address> | exit-check <group> <address> | tx <hash> | verify <receipt.json>   [--api <signer site>] [--rpc <url>]";

export interface Io {
  out: (s: string) => void;
  /** For tests: a chain reader instead of one on --rpc. */
  chain?: ChainReader & Pick<PublicClient, "readContract">;
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
}

const amount = (raw: string, decimals: number | null, symbol: string | null) => (decimals === null ? `${raw} raw units` : `${formatUnits(BigInt(raw), decimals)} ${symbol ?? ""}`.trim());

export async function main(argv: string[], io: Io | ((s: string) => void) = console.log, reader?: ChainReader): Promise<number> {
  const o: Io = typeof io === "function" ? { out: io, chain: reader as Io["chain"] } : io;
  const out = o.out;
  const flags = new Map<string, string>();
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i]!.startsWith("--")) flags.set(argv[i]!.slice(2), argv[++i] ?? "");
    else args.push(argv[i]!);
  }
  const [cmd, a1, a2] = args;
  const env = o.env ?? process.env;
  const api = flags.get("api") ?? env.COFER_API;
  const chain = () => o.chain ?? (createPublicClient({ transport: http(flags.get("rpc") ?? MAINNET_RPC) }) as unknown as NonNullable<Io["chain"]>);
  const client = () => {
    if (!api) throw new Error("Give the signer site with --api https://<signer site> (or set COFER_API).");
    return createCoferClient({ baseUrl: api, fetch: o.fetch });
  };
  const addr = (s: string | undefined, what: string) => {
    if (!s || !isAddress(s, { strict: false })) throw new Error(`${what} must be an address (0x followed by 40 hex characters).`);
    return getAddress(s);
  };
  try {
    switch (cmd) {
      case "pot": {
        const p = await client().pot(addr(a1, "The group"));
        out(`Group account ${p.address}`);
        out(`Members: ${p.memberCount}. A vote needs ${p.voteRule.approvalsNeeded} approval(s) now${p.voteRule.thresholdBps ? ` (${p.voteRule.thresholdBps / 100}% of members, rounded up)` : ""}.`);
        out(`Exit window: ${p.exitWindowSeconds / 3600} h. Deposits ${p.depositsOpen ? "open" : "closed"}.`);
        for (const t of p.assets) out(`  ${amount(t.rawBalance, t.decimals, t.symbol)}  (${t.asset})`);
        return 0;
      }
      case "member": {
        const g = await client().keyGroups(addr(a1, "The address"));
        out(g.groups.length ? `${g.address} is an active member of ${g.groups.length} group(s):` : `${g.address} is not an active member of any group.`);
        for (const x of g.groups) out(`  ${x.pot}  shares ${formatUnits(BigInt(x.shares), 18)}  joined at block ${x.joinBlock ?? "unknown"}`);
        return 0;
      }
      case "exit-check": {
        const pot = addr(a1, "The group");
        const member = addr(a2, "The member");
        const c = chain();
        const info = (await c.readContract({ address: pot, abi: EXIT_ABI, functionName: "memberInfo", args: [member] })) as { active: boolean; shares: bigint };
        if (info.shares === 0n) {
          out(`${member} has no shares in ${pot}: nothing to exit.`);
          return 0;
        }
        const kit = await buildExit({ pot, shares: info.shares, to: member }, c as never);
        out(`${member} holds ${formatUnits(info.shares, 18)} shares in ${pot}. Exiting all of them now would pay, in kind:`);
        for (const p of kit.preview ?? []) out(`  ${p.amount} raw units of ${p.asset}`);
        out(`The call (sent by that member's own key account): to ${kit.call!.to}, data ${kit.call!.data}`);
        return 0;
      }
      case "tx": {
        if (!a1 || !/^0x[0-9a-fA-F]{64}$/.test(a1)) throw new Error("The hash must be 0x followed by 64 hex characters.");
        const e = await client().tx(a1 as `0x${string}`);
        out(e.summary);
        for (const ev of e.events) out(`  - ${ev.text}`);
        return 0;
      }
      case "verify": {
        if (!a1) throw new Error(USAGE);
        const v = await verifyReceipt(JSON.parse(readFileSync(a1, "utf8")), o.chain ?? flags.get("rpc") ?? MAINNET_RPC);
        out(verdictText(v));
        return v.ok ? 0 : 1;
      }
      default:
        out(USAGE);
        return 2;
    }
  } catch (e) {
    out((e as Error).message);
    return 2;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
