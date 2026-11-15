/**
 * The "kernel-passkey" label on a linked key is saved only for an account whose main (root) key is
 * the passkey validator: the server reads rootValidator() on the account before saving. A plain
 * wallet, any other contract, or a Kernel account with another main key is refused under this label.
 */
import { concatHex, type Hex } from "viem";
import { RHC } from "../chain/addresses";

/** Kernel v3.1 rootValidator() (bytes21 ValidationId): the validator type byte 0x01, then its address. */
export const KERNEL_ROOT_VALIDATOR_ABI = [
  { type: "function", name: "rootValidator", stateMutability: "view", inputs: [], outputs: [{ type: "bytes21" }] },
] as const;

/** The ValidationId of the ZeroDev passkey validator 0.0.3 as a Kernel v3.1 root key. */
export const PASSKEY_ROOT_VALIDATOR_ID: Hex = concatHex(["0x01", RHC.ZERODEV_PASSKEY_VALIDATOR_0_0_3]);

export const NOT_PASSKEY_ACCOUNT = "this key is not a Cofer passkey account; set up your key again from Telegram";

/** True only when the account's root key (as read on-chain) is the passkey validator. */
export function isPasskeyRoot(rootValidator: string | undefined | null): boolean {
  return typeof rootValidator === "string" && rootValidator.toLowerCase() === PASSKEY_ROOT_VALIDATOR_ID.toLowerCase();
}
