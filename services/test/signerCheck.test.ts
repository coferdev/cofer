import { describe, expect, test } from "bun:test";
import { getAddress } from "viem";
import { NO_KEY, sameAddress, signerProblem, WRONG_KEY } from "../src/core/signerCheck";

const linked = getAddress("0x00000000000000000000000000000000000000aa");
const other = getAddress("0x45f6000000000000000000000000000000000001");

describe("linked key check before member actions", () => {
  test("the linked key passes, whatever the upper/lower case", () => {
    expect(signerProblem(linked, linked)).toBeNull();
    expect(signerProblem(linked.toLowerCase(), linked)).toBeNull();
    expect(sameAddress(linked, linked.toLowerCase())).toBe(true);
  });

  test("a different passkey is stopped with the exact message", () => {
    expect(signerProblem(linked, other)).toBe(WRONG_KEY);
    expect(WRONG_KEY).toBe("That's not the passkey linked to your Cofer account. Try again and pick a different passkey.");
  });

  test("no linked key yet is stopped too", () => {
    expect(signerProblem(null, other)).toBe(NO_KEY);
    expect(signerProblem(undefined, other)).toBe(NO_KEY);
    expect(signerProblem("", other)).toBe(NO_KEY);
  });
});
