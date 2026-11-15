/**
 * The saved kind of a member's key decides everything on the signer page:
 *  - "kernel-passkey": a Kernel v3.1 account whose main (root) key is the passkey validator.
 *    The page only ever offers the passkey.
 *  - "kernel-ecdsa": a Kernel v3.1 account whose main key is the member's own wallet (ECDSA validator).
 *    The page only ever offers Connect wallet.
 * The two are never mixed: no wallet is ever added to a passkey account, or the other way round.
 *
 * The server saves a kind only after reading rootValidator() on the account: the label must match
 * the account's real main key.
 */
import { concatHex, getAddress, type Address, type Hex } from "viem";
import { RHC } from "../chain/addresses";

export type KeyKind = "kernel-passkey" | "kernel-ecdsa";

/** Kernel v3.1 rootValidator() (bytes21 ValidationId): the validator type byte 0x01, then its address. */
export const KERNEL_ROOT_VALIDATOR_ABI = [
  { type: "function", name: "rootValidator", stateMutability: "view", inputs: [], outputs: [{ type: "bytes21" }] },
] as const;

/** The ECDSA validator's public getter: the wallet that owns a Kernel account. */
export const ECDSA_OWNER_ABI = [
  { type: "function", name: "ecdsaValidatorStorage", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "address" }] },
] as const;

/** The ValidationId of the ZeroDev passkey validator 0.0.3 as a Kernel v3.1 root key. */
export const PASSKEY_ROOT_VALIDATOR_ID: Hex = concatHex(["0x01", RHC.ZERODEV_PASSKEY_VALIDATOR_0_0_3]);
/** The ValidationId of the Kernel v3.1 ECDSA validator as a root key. */
export const ECDSA_ROOT_VALIDATOR_ID: Hex = concatHex(["0x01", RHC.ZERODEV_ECDSA_VALIDATOR_KERNEL_3_1]);

const ROOT_ID: Record<KeyKind, Hex> = { "kernel-passkey": PASSKEY_ROOT_VALIDATOR_ID, "kernel-ecdsa": ECDSA_ROOT_VALIDATOR_ID };

export const NOT_PASSKEY_ACCOUNT = "this key is not a Cofer passkey account; set up your key again from Telegram";
export const NOT_WALLET_ACCOUNT = "this key is not a Cofer wallet account; set up your key again from Telegram";

/** The refusal for a key whose main key does not match the kind it is saved under. */
export const WRONG_KIND_TEXT: Record<KeyKind, string> = { "kernel-passkey": NOT_PASSKEY_ACCOUNT, "kernel-ecdsa": NOT_WALLET_ACCOUNT };

/** True only when the account's root key (as read on-chain) is the one this kind requires. */
export function rootMatches(kind: KeyKind, rootValidator: string | undefined | null): boolean {
  return typeof rootValidator === "string" && rootValidator.toLowerCase() === ROOT_ID[kind].toLowerCase();
}

/** Kept for callers that only know the passkey kind. */
export function isPasskeyRoot(rootValidator: string | undefined | null): boolean {
  return rootMatches("kernel-passkey", rootValidator);
}

/** The page's key for a saved kind: only "kernel-ecdsa" is a wallet; anything else stays on the passkey page as today. */
export function isWalletKind(accountKind: string | null | undefined): boolean {
  return accountKind === "kernel-ecdsa";
}

/**
 * The Kernel v3.1 account address for a wallet as its main key (index 0). Pure: computed from the
 * factory, the account code hash, the ECDSA validator and the wallet, so it is the same on every visit.
 */
export async function walletAccountAddress(owner: Address): Promise<Address> {
  const { getKernelAddressFromECDSA } = await import("@zerodev/ecdsa-validator");
  const { getEntryPoint, KERNEL_V3_1 } = await import("@zerodev/sdk/constants");
  const { constants } = await import("@zerodev/sdk");
  return getAddress(
    await getKernelAddressFromECDSA({
      entryPoint: getEntryPoint("0.7"),
      kernelVersion: KERNEL_V3_1,
      eoaAddress: owner,
      index: 0n,
      initCodeHash: constants.KernelVersionToAddressesMap[KERNEL_V3_1].initCodeHash as Hex,
    }),
  );
}
