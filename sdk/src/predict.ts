/**
 * A group's account address, worked out offline. Cofer's factory creates each group account (a "pot") as a minimal
 * clone (EIP-1167) at a CREATE2 address, so the address is known before the account exists:
 *
 *   salt      = keccak256("cofer:" + chatId)                      (as the bot does when a group runs /newpot)
 *   cloneSalt = keccak256(abi.encode(creator, salt))              (CoferFactory.predictPot)
 *   address   = CREATE2(factory, cloneSalt, the clone's creation code for `implementation`)
 *
 * The same maths as CoferFactory.predictPot(creator, salt), so the answer matches
 * `cast call <factory> "predictPot(address,bytes32)(address)" <creator> <salt>`.
 */
import { encodeAbiParameters, getAddress, getContractAddress, keccak256, toHex, type Address, type Hex } from "viem";

/** The factories Cofer runs, with the group-account template each one clones (public, on-chain: factory.implementation()). */
export const FACTORIES: Record<number, { factory: Address; implementation: Address }> = {
  4663: { factory: "0x5d03d53A5630ceCC545Be46635779094A11E47D7", implementation: "0xA44Fc8063291d1eFAbC8dd0D4ADd0aAe37F55BdF" },
  46630: { factory: "0x814c1422e3efb7762b08533e518b758033f25e45", implementation: "0x04C63a44Aa65e40514FDB21f93F7be91b95BE6e9" },
};

/** The salt the bot uses for a group: keccak256 of the text "cofer:" followed by the chat id. */
export function potSalt(chatId: number | bigint | string): Hex {
  const id = String(chatId).trim();
  if (!/^-?\d+$/.test(id)) throw new Error(`chatId must be a whole number, got "${id}"`);
  return keccak256(toHex(`cofer:${id}`));
}

/** The EIP-1167 minimal clone's creation code for `implementation` (as in the factory's Clones library). */
export function cloneCreationCode(implementation: Address): Hex {
  return `0x3d602d80600a3d3981f3363d3d373d3d3d363d73${getAddress(implementation).slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`;
}

export interface PredictInput {
  /** The Telegram group's chat id (a negative number for groups). Used only here, offline. */
  chatId: number | bigint | string;
  /** The key that created (or will create) the group account with /newpot. */
  creator: Address;
  /** The factory address, or a chain id with a known factory (4663 mainnet, 46630 testnet). */
  factory: Address | number;
  /** The template the factory clones (factory.implementation()). Needed only for a factory not in FACTORIES. */
  implementation?: Address;
}

/** The group account address CoferFactory.predictPot would give, computed offline. */
export function predictPotAddress(i: PredictInput): Address {
  let factory: Address;
  let implementation = i.implementation;
  if (typeof i.factory === "number") {
    const known = FACTORIES[i.factory];
    if (!known) throw new Error(`no known Cofer factory on chain ${i.factory}; pass the factory and implementation addresses`);
    factory = known.factory;
    implementation ??= known.implementation;
  } else {
    factory = getAddress(i.factory);
    implementation ??= Object.values(FACTORIES).find((f) => f.factory.toLowerCase() === factory.toLowerCase())?.implementation;
  }
  if (!implementation) throw new Error("unknown factory: pass its implementation address (cast call <factory> \"implementation()(address)\")");
  const cloneSalt = keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [getAddress(i.creator), potSalt(i.chatId)]));
  return getContractAddress({ opcode: "CREATE2", from: factory, salt: cloneSalt, bytecode: cloneCreationCode(implementation) });
}
