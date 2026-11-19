import { describe, expect, test } from "bun:test";
import { keccak256, toHex } from "viem";
import { FACTORIES, potSalt, predictPotAddress } from "../src";

/**
 * Answers recorded from the live factories on 2026-11-16 with
 *   cast call <factory> "predictPot(address,bytes32)(address)" <creator> $(cast keccak "cofer:<chatId>")
 * (mainnet 4663 and testnet 46630, public RPCs). The SDK must give exactly the same address, offline.
 */
const CREATORS = ["0x1111111111111111111111111111111111111111", "0x5ACD09eAe4f160e2f2e2356e6eF0496EF6f0f064"] as const;
const RECORDED: [number, string, (typeof CREATORS)[number], `0x${string}`][] = [
  [4663, "-1001234567890", CREATORS[0], "0x650451dEE919161f7378D2937dC1fa5089f75097"],
  [46630, "-1001234567890", CREATORS[0], "0x25179D6E29bDb49248342BB8fa0bf49f528b6b8B"],
  [4663, "-1001234567890", CREATORS[1], "0xB3c0200fEF607E639491E5b235969d46173Ca635"],
  [46630, "-1001234567890", CREATORS[1], "0x59d4aC22b0ec7fbadBC6BE0Fb5105b88777f5f4a"],
  [4663, "-5000000001", CREATORS[0], "0x815CD09b6D04D445A117deD60404006E6a72eec4"],
  [46630, "-5000000001", CREATORS[0], "0x7007250EBEDDA070551D6c6Cb8Fc3cE20ba2b5A8"],
  [4663, "-5000000001", CREATORS[1], "0x15fD1D049E21901f4aFb596686FCa7db90D5A07c"],
  [46630, "-5000000001", CREATORS[1], "0xbB35B8a4C790428f5Ff957CFE8BB3e8Ba3896C01"],
  [4663, "42", CREATORS[0], "0x90DF84D2247d65F35ffD295334Bb6a91e8f15d84"],
  [46630, "42", CREATORS[0], "0x6cb65bA34938d4C6129B0AF7009eB98B7A1D2DFc"],
  [4663, "42", CREATORS[1], "0xe92B4b1304517c8129B5437BBF6324A9D661b855"],
  [46630, "42", CREATORS[1], "0xd1aEBD4c30bE4A33989e733d268ce084bA34407D"],
];

describe("predictPotAddress", () => {
  for (const [chain, chatId, creator, want] of RECORDED) {
    test(`matches factory.predictPot on chain ${chain} for chat ${chatId}`, () => {
      expect(predictPotAddress({ chatId, creator, factory: chain })).toBe(want);
    });
  }

  test("a factory address works the same as its chain id; numbers, bigints and strings give the same answer", () => {
    const byAddr = predictPotAddress({ chatId: -1001234567890, creator: CREATORS[0], factory: FACTORIES[4663]!.factory });
    expect(byAddr).toBe("0x650451dEE919161f7378D2937dC1fa5089f75097");
    expect(predictPotAddress({ chatId: -1001234567890n, creator: CREATORS[0], factory: 4663 })).toBe(byAddr);
  });

  test("the salt is the bot's: keccak256 of \"cofer:\" and the chat id", () => {
    expect(potSalt(-1001234567890)).toBe(keccak256(toHex("cofer:-1001234567890")));
    expect(() => potSalt("12a")).toThrow("whole number");
  });

  test("an unknown factory needs its implementation address", () => {
    expect(() => predictPotAddress({ chatId: 1, creator: CREATORS[0], factory: "0x0000000000000000000000000000000000000abc" })).toThrow("implementation");
    expect(() => predictPotAddress({ chatId: 1, creator: CREATORS[0], factory: 1 })).toThrow("no known Cofer factory");
    expect(predictPotAddress({ chatId: 42, creator: CREATORS[0], factory: FACTORIES[46630]!.factory, implementation: FACTORIES[46630]!.implementation })).toBe("0x6cb65bA34938d4C6129B0AF7009eB98B7A1D2DFc");
  });
});
