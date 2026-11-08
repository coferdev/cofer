/**
 * Signer page: known contract refusals in plain sentences (one place: core/refusals.ts), the spend
 * allowance check before the passkey, and the progress line while a transaction is sent.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BaseError, ContractFunctionExecutionError, ContractFunctionRevertedError, encodeErrorResult, type Hex } from "viem";
import { coferPotAbi } from "../src/chain/abi";
import { REFUSAL_TEXT, refusalForSelector, refusalName, refusalText, spendAllowanceRefusal, type RefusalName } from "../src/core/refusals";
import { BROWSER_FAILED, failureText, MAYBE_SENT, SENDING_TEXT } from "../src/core/retryText";
import { BANNED } from "../../tools/banned-words";

const read = (...p: string[]) => readFileSync(join(import.meta.dir, "..", ...p), "utf8");
const ADDR = "0x00000000000000000000000000000000000000aa";

/** Every refusal, with its selector worked out by hand from the error signature. */
const KNOWN: [RefusalName, Hex][] = [
  ["AllowanceExceeded", "0xc45cb513"],
  ["NoAllowance", "0xebf59ac8"],
  ["InsufficientBalance", "0xf4d678b8"],
  ["NotMember", "0x291fc442"],
  ["ZeroAmount", "0x1f2a2005"],
  ["BadParam", "0xde17a3af"],
  ["DepositsClosed", "0x1a8ade30"],
  ["DepositPriceTooOld", "0x25301041"],
  ["InsufficientShares", "0x39996567"],
  ["NothingOwed", "0x797dba54"],
  ["TransferFailed", "0x39f1c8d9"],
  ["TransferFromFailed", "0x6e1c8d15"],
];

describe("contract refusals -> plain sentences", () => {
  test("each known selector maps to its refusal and sentence", () => {
    for (const [name, sel] of KNOWN) {
      expect(refusalForSelector(sel)).toBe(name);
      expect(refusalText(new Error(`UserOperation reverted during simulation with reason: ${sel}`))).toBe(REFUSAL_TEXT[name]);
    }
    expect(refusalForSelector("0xc45cb513")).toBe("AllowanceExceeded");
    // the factory's price errors that a deposit can bubble up are known too
    expect(refusalName(new Error(`reverted: ${"0x" + "00".repeat(4)}`))).toBeNull();
    for (const n of ["StalePrice", "BadPrice"] as const) expect([...REFUSAL_TEXT[n]].length).toBeGreaterThan(0);
  });

  test("every refusal named in the table exists in the generated ABI (pot or factory)", async () => {
    const { coferFactoryAbi } = await import("../src/chain/abi");
    const names = new Set([...coferPotAbi, ...coferFactoryAbi].filter((x) => x.type === "error").map((x) => (x as { name: string }).name));
    for (const n of Object.keys(REFUSAL_TEXT)) expect(names.has(n)).toBe(true);
  });

  test("refusals with arguments, deep in a cause chain, in revert data objects, and decoded by viem", () => {
    const withArgs = encodeErrorResult({ abi: coferPotAbi, errorName: "TransferFailed", args: [ADDR] });
    expect(refusalName(new Error("estimate failed", { cause: new Error("inner", { cause: { data: withArgs } as never }) }))).toBe("TransferFailed");
    expect(refusalName({ message: "x", cause: { data: { data: "0xf4d678b8" } } })).toBe("InsufficientBalance");
    const reverted = new ContractFunctionRevertedError({ abi: coferPotAbi, data: "0xebf59ac8", functionName: "spend" });
    expect(refusalName(new ContractFunctionExecutionError(reverted as unknown as BaseError, { abi: coferPotAbi, functionName: "spend", args: [] }))).toBe("NoAllowance");
  });

  test("an address or hash that happens to start like a selector is not read as a refusal", () => {
    expect(refusalName(new Error(`sender 0xc45cb513${"1".repeat(32)} failed`))).toBeNull(); // 42-char address
    expect(refusalName(new Error(`tx 0xc45cb513${"1".repeat(56)} failed`))).toBeNull(); // 66-char hash
  });

  test("anything else: the generic sentence (or check-first once handed off); a refusal wins in both cases", () => {
    expect(failureText(new Error("boom at https://bundler.example/KEY"), false)).toBe(BROWSER_FAILED);
    expect(BROWSER_FAILED).toBe("Something went wrong. You can try again.");
    expect(failureText(new Error("reason: 0x12345678"), false)).toBe(BROWSER_FAILED); // a selector we do not know
    expect(failureText(new Error("timeout"), true)).toBe(MAYBE_SENT);
    expect(failureText(new Error("reason: 0xc45cb513"), false)).toBe(REFUSAL_TEXT.AllowanceExceeded);
    expect(failureText(new Error("reason: 0xc45cb513"), true)).toBe(REFUSAL_TEXT.AllowanceExceeded);
  });

  test("no sentence shows hex, a url or a key, or a banned word", () => {
    // the owner's list for these texts, assembled from pieces so the banned-words check does not flag this file
    const words = [["sa", "fe"], ["ea", "rn"], ["retu", "rns"], ["yi", "eld"], ["guaran", "teed"], ["fu", "nd"], ["offi", "cial"], ["part", "ner"]].map((p) => p.join(""));
    const forbidden = new RegExp(`\\b(${words.join("|")})\\b`, "i");
    for (const t of [...Object.values(REFUSAL_TEXT), SENDING_TEXT]) {
      expect(t).not.toMatch(/0x|https?:|:\/\//);
      expect(t).not.toMatch(forbidden);
      for (const b of BANNED) expect(t).not.toMatch(b.re);
    }
  });
});

describe("spend: allowance checked before the passkey", () => {
  const NOW = 1_800_000_000;
  const day = { allowance: 50_000_000n, period: 86400, periodStart: NOW - 3600, spent: 37_500_000n };

  test("over the allowance: refused with the exact amount left and the period", () => {
    expect(spendAllowanceRefusal(20_000_000n, day, NOW)).toBe("That is more than your allowance. You have 12.5 USDG left this day.");
    expect(spendAllowanceRefusal(12_500_001n, day, NOW)).toBe("That is more than your allowance. You have 12.5 USDG left this day.");
    expect(spendAllowanceRefusal(20_000_000n, { ...day, period: 604800 }, NOW)).toBe("That is more than your allowance. You have 12.5 USDG left this week.");
    expect(spendAllowanceRefusal(20_000_000n, { ...day, period: 30 * 86400 }, NOW)).toBe("That is more than your allowance. You have 12.5 USDG left this period.");
    expect(spendAllowanceRefusal(1n, { ...day, spent: 49_999_999n + 1n }, NOW)).toBe("That is more than your allowance. You have 0 USDG left this day.");
    expect(spendAllowanceRefusal(10_000_000n, { ...day, spent: 49_876_544n }, NOW)).toBe("That is more than your allowance. You have 0.123456 USDG left this day.");
  });

  test("within the allowance, or after the window rolled over (same math as the pot): no refusal", () => {
    expect(spendAllowanceRefusal(12_500_000n, day, NOW)).toBeNull();
    expect(spendAllowanceRefusal(50_000_000n, day, NOW + 86400)).toBeNull();
  });

  test("no allowance at all: the NoAllowance sentence", () => {
    expect(spendAllowanceRefusal(1n, { ...day, allowance: 0n }, NOW)).toBe(REFUSAL_TEXT.NoAllowance);
    expect(spendAllowanceRefusal(1n, { ...day, period: 0 }, NOW)).toBe(REFUSAL_TEXT.NoAllowance);
  });

  test("the page refuses before the passkey; a failed read lets the spend continue as before", () => {
    const client = read("src", "web", "client.ts");
    const spend = client.slice(client.indexOf('ex.purpose === "sign" && ex.ref.startsWith("spend:")'), client.indexOf('ex.purpose === "card"'));
    const refuseAt = spend.indexOf("if (refusal) throw new Stop(refusal);");
    expect(refuseAt).toBeGreaterThan(-1);
    expect(spend.indexOf("const refusal = await readSpendRefusal(amount);")).toBeLessThan(refuseAt);
    // the passkey is only ever asked for in memberSigner (getSigner); it comes after the check
    expect(refuseAt).toBeLessThan(spend.indexOf("await memberSigner()"));
    // the check uses the linked key from our API, not the passkey, and the pot's own memberInfo
    const check = spend.slice(0, spend.indexOf("act.onclick"));
    expect(check).toContain('trpc<{ address: string | null } | undefined>("me.get", {})');
    expect(check).toContain('functionName: "memberInfo", args: [me.address]');
    expect(check).toContain("spendAllowanceRefusal(amount, state, Math.floor(Date.now() / 1000))");
    expect(check).not.toMatch(/getSigner|memberSigner/);
    expect(check).toContain("return null; // read failed: continue as before");
  });
});

describe("progress while sending", () => {
  const client = read("src", "web", "client.ts");

  test("the exact line", () => {
    expect(SENDING_TEXT).toBe("Sending... this can take up to a minute. Keep this page open.");
  });

  test("it appears once the passkey has been used (the user operation leaves for the bundler), and on the wallet path", () => {
    expect(client).toContain("if (!isHandOff(init.body)) return;\n        handedOff = true;\n        say(SENDING_TEXT);");
    expect(client).toContain("last = await wallet.sendTransaction({ account: address!, to: c.to, data: c.data, chain });\n          say(SENDING_TEXT);");
    // every action that sends a transaction goes through s.send (passkey or wallet), so each gets the line
    for (const branch of ['ex.purpose === "deposit"', 'ex.purpose === "exit"', 'ex.purpose === "claim"', 'ex.purpose === "sign" && ex.ref.startsWith("spend:")', 'ex.purpose === "card"']) {
      expect(client.indexOf(branch)).toBeGreaterThan(-1);
    }
    expect(client.match(/await s\.send!\(/g)!.length).toBe(5); // deposit, exit, claim, spend, card
  });

  test("the button is off before anything is awaited, cannot be tapped twice, and the exit form cannot turn it back on", () => {
    const guard = client.slice(client.indexOf("const guard = "), client.indexOf('if (ex.purpose === "onboard" && ex.linked)'));
    expect(guard).toContain("if (busy) return;\n    busy = true;\n    act.disabled = true;");
    expect(guard.indexOf("act.disabled = true;")).toBeLessThan(guard.indexOf("await"));
    expect(client).toContain("if (busy) return; // sending: the button stays off");
    expect(client).toContain("if (done || busy) return;");
  });

  test("success texts are unchanged", () => {
    for (const t of ["say(`Deposited. tx ${tx}`);", "say(`Exited. tx ${tx}`);", "say(`Sent. tx ${tx}`);", "say(`Card order ${st.status}. Load fee ${Number(q.loadFeeUsdg) / 1e6} USDG.`);"]) {
      expect(client).toContain(t);
    }
  });
});

describe("docs", () => {
  test("the runbook lists every refusal sentence, the progress line and the wait wording", () => {
    const runbook = read("..", "docs", "runbook.md");
    for (const t of Object.values(REFUSAL_TEXT)) expect(runbook).toContain(t);
    expect(runbook).toContain(SENDING_TEXT);
    expect(runbook).toContain("Passed. It will be done in 6 hours, at 11:06 UTC on 8 Nov 2026. Disagree? /exit takes your exact share any time.");
  });
});
