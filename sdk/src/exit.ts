/**
 * The exit kit: everything a member's exit needs, prepared offline or with one read of the chain.
 *   - the exact call: CoferPot.exit(shares, to), sent by the member's own key account to the group account;
 *   - the preview: what those shares pay right now (previewExit), when a chain reader is given;
 *   - the destination checks the signer page uses (same reasons, same order), so a mistyped or contract address is
 *     refused before anything is signed;
 *   - the steps to check it on a block explorer.
 * Exits use no price and no vote; nothing can pause them. Tokens that cannot be sent during the exit are set aside
 * for the destination (claimOwed).
 */
import { encodeFunctionData, getAddress, isAddress, type Address, type Hex } from "viem";

export const EXIT_ABI = [
  { type: "function", name: "exit", stateMutability: "nonpayable", inputs: [{ name: "shares", type: "uint256" }, { name: "to", type: "address" }], outputs: [] },
  { type: "function", name: "previewExit", stateMutability: "view", inputs: [{ name: "shares", type: "uint256" }], outputs: [{ name: "assets", type: "address[]" }, { name: "amounts", type: "uint256[]" }] },
  { type: "function", name: "memberInfo", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "v", type: "tuple", components: [{ name: "active", type: "bool" }, { name: "shares", type: "uint256" }, { name: "allowance", type: "uint128" }, { name: "period", type: "uint32" }, { name: "periodStart", type: "uint64" }, { name: "spent", type: "uint128" }] }] },
] as const;

/** The signer page's reasons for refusing a destination (services/src/core/exitDestination.ts, word for word). */
export const DEST_TEXT = {
  empty: "Type the address, or close \"Send to a different address\" to exit to your own key.",
  invalid: "That is not a valid address. It must be 0x followed by 40 letters and numbers, copied exactly.",
  zero: "That is the zero address. Anything sent there is lost.",
  pot: "That is this group account's own contract, not a wallet.",
  otherPot: "That is a Cofer group account contract, not a wallet.",
  factory: "That is the Cofer factory contract, not a wallet.",
  feeRouter: "That is the Cofer fee contract, not a wallet.",
  adapter: "That is the Cofer swap contract, not a wallet.",
  usdg: "That is the USDG token contract. Tokens sent there are lost.",
  stockToken: "That is a Stock Token's contract address. Tokens sent there are lost.",
} as const;

/** Contract addresses an exit may never be sent to (all public, on-chain). */
export interface BlockedAddresses {
  pot: Address;
  factory?: Address;
  feeRouter?: Address;
  adapters: readonly Address[];
  usdg: Address;
  stockTokens: readonly Address[];
  /** Other Cofer group accounts (factory.isPot). */
  otherPots?: readonly Address[];
}

const ZERO = "0x0000000000000000000000000000000000000000";
const same = (a: string | undefined, b: string) => !!a && a.toLowerCase() === b.toLowerCase();

/** A refusal reason for a destination, or null if it may be used. Same checks, same order, as the signer page. */
export function destinationProblem(typed: string, b: BlockedAddresses): string | null {
  const t = typed.trim();
  if (t === "") return DEST_TEXT.empty;
  if (!/^0x[0-9a-fA-F]{40}$/.test(t) || !isAddress(t)) return DEST_TEXT.invalid;
  if (same(t, ZERO)) return DEST_TEXT.zero;
  if (same(t, b.pot)) return DEST_TEXT.pot;
  if (same(b.factory, t)) return DEST_TEXT.factory;
  if (same(b.feeRouter, t)) return DEST_TEXT.feeRouter;
  if (b.adapters.some((a) => same(a, t))) return DEST_TEXT.adapter;
  if (same(b.usdg, t)) return DEST_TEXT.usdg;
  if (b.stockTokens.some((a) => same(a, t))) return DEST_TEXT.stockToken;
  if (b.otherPots?.some((a) => same(a, t))) return DEST_TEXT.otherPot;
  return null;
}

/** Anything that can read a view function (a viem public client works). */
export interface Reader {
  readContract(a: { address: Address; abi: typeof EXIT_ABI; functionName: "previewExit"; args: readonly [bigint] }): Promise<readonly [readonly Address[], readonly bigint[]]>;
}

export interface ExitInput {
  pot: Address;
  shares: bigint | string;
  to: string;
  /** The contract addresses to refuse as a destination. Without it, only the format, zero and the pot itself are checked. */
  blocked?: Omit<BlockedAddresses, "pot">;
}

export interface ExitKit {
  /** Why this exit must not be sent, or null. */
  refused: string | null;
  /** The call the member's key account sends to the group account (null when refused). */
  call: { to: Address; data: Hex; value: "0"; function: "exit(uint256,address)"; args: { shares: string; to: Address } } | null;
  /** What the shares pay now, per token in raw units (null without a reader, or when refused). */
  preview: { asset: Address; amount: string }[] | null;
  /** How to check it on a block explorer. */
  steps: string[];
}

export async function buildExit(i: ExitInput, reader?: Reader): Promise<ExitKit> {
  const pot = getAddress(i.pot);
  let shares: bigint;
  try {
    shares = BigInt(i.shares);
  } catch {
    shares = -1n;
  }
  const steps = [
    `Open the group account ${pot} on the block explorer, then Contract, then Read contract.`,
    "Run memberInfo with your key's address: the second value is your share count.",
    `Run previewExit with ${shares > 0n ? shares : "your share count"}: two lists, each token and the raw amount you get.`,
    "Exit from the signer page, or have your key account send the call above to the group account.",
    "Then open the exit transaction: the Exited log names your key, the destination, the shares and every amount paid.",
  ];
  const refused = shares <= 0n ? "The share count must be a whole number above 0." : destinationProblem(i.to, { pot, adapters: [], stockTokens: [], usdg: ZERO as Address, ...i.blocked });
  if (refused) return { refused, call: null, preview: null, steps };
  const to = getAddress(i.to.trim());
  const data = encodeFunctionData({ abi: EXIT_ABI, functionName: "exit", args: [shares, to] });
  let preview: ExitKit["preview"] = null;
  if (reader) {
    const [assets, amounts] = await reader.readContract({ address: pot, abi: EXIT_ABI, functionName: "previewExit", args: [shares] });
    preview = assets.map((a, k) => ({ asset: getAddress(a), amount: (amounts[k] ?? 0n).toString() }));
  }
  return { refused: null, call: { to: pot, data, value: "0", function: "exit(uint256,address)", args: { shares: shares.toString(), to } }, preview, steps };
}
