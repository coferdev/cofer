/**
 * Exit to a different address (signer page): the refused destinations, the summary with the
 * destination and the network, the summary-versus-signed check, the unchanged default, that no
 * link can carry a destination, both the passkey and the wallet paths, and the warning texts.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeFunctionData, encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { encodeCallDataEpV07 } from "@zerodev/sdk";
import { coferPotAbi } from "../src/chain/abi";
import {
  chooseExitDestination,
  DEST_TEXT,
  destinationProblem,
  EXIT_CONFIRM_TEXT,
  EXIT_NETWORK_WARNING,
  EXIT_TOGGLE_TEXT,
  groupAddress,
  type BlockedAddresses,
} from "../src/core/exitDestination";
import { PASSKEY_LOSS_WARNING } from "../src/core/passkeyWarning";
import { callDataCarries, checkExitCalls, exitCalls, pageSummary, type ExitCall } from "../src/core/signCheck";
import { parseLinkRequest } from "../src/dashboard/routes";
import { signerPage } from "../src/web/page";

const A = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`) as Address;
const POT = A(0xa1);
const FACTORY = A(0xf1);
const FEE_ROUTER = A(0xfe);
const ADAPTER = A(0xad);
const USDG = A(0x05d6);
const STOCK1 = A(0x5701);
const STOCK2 = A(0x5702);
const OWN = getAddress("0x1111111111111111111111111111111111111111");
const FRIEND = getAddress("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed"); // checksummed form has mixed case
/** FRIEND with the case of its first letter flipped: the checksum no longer matches. */
const BAD_CHECKSUM = FRIEND.replace(/[a-fA-F]/, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
const BLOCKED: BlockedAddresses = { pot: POT, factory: FACTORY, feeRouter: FEE_ROUTER, adapters: [ADAPTER], usdg: USDG, stockTokens: [USDG, STOCK1, STOCK2] };
const notMeta = () => ({ symbol: "", decimals: 0 });
const root = join(import.meta.dir, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("destination checks", () => {
  test("each refused address gets its plain reason", () => {
    const cases: [string, string][] = [
      ["0x0000000000000000000000000000000000000000", DEST_TEXT.zero],
      [POT, DEST_TEXT.pot],
      [POT.toLowerCase(), DEST_TEXT.pot],
      [FACTORY, DEST_TEXT.factory],
      [FEE_ROUTER, DEST_TEXT.feeRouter],
      [ADAPTER, DEST_TEXT.adapter],
      [USDG, DEST_TEXT.usdg],
      [STOCK1, DEST_TEXT.stockToken],
      [STOCK2.toLowerCase(), DEST_TEXT.stockToken],
      ["", DEST_TEXT.empty],
      ["   ", DEST_TEXT.empty],
      ["0x1234", DEST_TEXT.invalid],
      ["1111111111111111111111111111111111111111", DEST_TEXT.invalid],
      ["0x11111111111111111111111111111111111111zz", DEST_TEXT.invalid],
      ["bob.eth", DEST_TEXT.invalid],
      // one letter's case changed: the checksum no longer matches, so it may be a typo
      [BAD_CHECKSUM, DEST_TEXT.invalid],
    ];
    for (const [typed, reason] of cases) expect(`${typed} -> ${destinationProblem(typed, BLOCKED)}`).toBe(`${typed} -> ${reason}`);
  });

  test("an ordinary wallet address is accepted, checksummed or all lower case, with spaces around it", () => {
    expect(destinationProblem(FRIEND, BLOCKED)).toBeNull();
    expect(destinationProblem(FRIEND.toLowerCase(), BLOCKED)).toBeNull();
    expect(destinationProblem(`  ${FRIEND}  `, BLOCKED)).toBeNull();
    const r = chooseExitDestination({ own: OWN, open: true, typed: ` ${FRIEND.toLowerCase()} `, confirmed: true, blocked: BLOCKED });
    expect(r).toEqual({ ok: true, to: FRIEND, custom: true });
  });

  test("a different address needs the checkbox ticked", () => {
    expect(chooseExitDestination({ own: OWN, open: true, typed: FRIEND, confirmed: false, blocked: BLOCKED })).toEqual({ ok: false, reason: DEST_TEXT.notConfirmed });
  });

  test("a refused address is refused even with the box ticked", () => {
    expect(chooseExitDestination({ own: OWN, open: true, typed: STOCK1, confirmed: true, blocked: BLOCKED })).toEqual({ ok: false, reason: DEST_TEXT.stockToken });
  });

  test("the address is shown in full, checksummed, in groups of four", () => {
    const g = groupAddress(FRIEND.toLowerCase());
    expect(g).toMatch(/^0x[0-9a-fA-F]{4}( [0-9a-fA-F]{4}){9}$/);
    expect(g.replace(/ /g, "")).toBe(FRIEND);
    expect(g.split(" ").length).toBe(10);
  });
});

describe("default: the member's own key, unchanged", () => {
  test("closed (the default): always the own key, whatever was typed or ticked", () => {
    for (const typed of ["", FRIEND, STOCK1, "garbage"]) {
      for (const confirmed of [false, true]) {
        expect(chooseExitDestination({ own: OWN.toLowerCase() as Address, open: false, typed, confirmed, blocked: BLOCKED })).toEqual({ ok: true, to: OWN, custom: false });
      }
    }
  });

  test("the call sent by default is byte for byte the one sent before this change: exit(shares, own key)", () => {
    const shares = 123_456_789_012_345_678_901n;
    const before = encodeFunctionData({ abi: coferPotAbi, functionName: "exit", args: [shares, OWN] });
    expect(exitCalls({ kind: "exit", pot: POT, shares, to: OWN, own: true })).toEqual([{ to: POT, data: before }]);
  });

  test("typing your own key counts as your own key", () => {
    expect(chooseExitDestination({ own: OWN, open: true, typed: OWN.toLowerCase(), confirmed: true, blocked: BLOCKED })).toEqual({ ok: true, to: OWN, custom: false });
  });
});

describe("You are signing: destination and network", () => {
  const shown: ExitCall = { kind: "exit", pot: POT, shares: 5_000_000n, to: FRIEND, own: false };

  test("states the destination in groups, that it is not the member's key, and Network: Robinhood Chain", () => {
    const s = pageSummary(shown, notMeta);
    expect(s).toContain(`Destination: ${groupAddress(FRIEND)} (a different address, not your key)`);
    expect(s).toContain("Network: Robinhood Chain");
    expect(s).toContain(`group account ${POT}`);
    expect(s).toContain("Shares: 5000000");
  });

  test("the own key is labelled as such", () => {
    expect(pageSummary({ ...shown, to: OWN, own: true }, notMeta)).toContain(`Destination: ${groupAddress(OWN)} (your own key)`);
  });

  test("the calls built from the summary pass the check", () => {
    expect(checkExitCalls(exitCalls(shown), shown)).toEqual({ ok: true });
  });

  test("a call whose destination differs from the one shown is refused", () => {
    const other = { ...shown, to: getAddress("0x2222222222222222222222222222222222222222") };
    expect(checkExitCalls(exitCalls(other), shown)).toEqual({ ok: false, problem: "destination differs from the summary" });
    // also the member's own key when a different address was shown, and the reverse
    expect(checkExitCalls(exitCalls({ ...shown, to: OWN }), shown)).toEqual({ ok: false, problem: "destination differs from the summary" });
    expect(checkExitCalls(exitCalls(shown), { ...shown, to: OWN, own: true })).toEqual({ ok: false, problem: "destination differs from the summary" });
  });

  test("other differences are refused too: shares, pot, function, extra calls, junk", () => {
    expect(checkExitCalls(exitCalls({ ...shown, shares: 5_000_001n }), shown).ok).toBe(false);
    expect(checkExitCalls(exitCalls({ ...shown, pot: A(0xa2) }), shown)).toEqual({ ok: false, problem: "call is not to the shown pot" });
    const claim = encodeFunctionData({ abi: coferPotAbi, functionName: "claimOwed", args: [USDG, FRIEND] });
    expect(checkExitCalls([{ to: POT, data: claim }], shown)).toEqual({ ok: false, problem: "call is claimOwed, not exit" });
    expect(checkExitCalls([...exitCalls(shown), ...exitCalls(shown)], shown)).toEqual({ ok: false, problem: "not exactly one call" });
    expect(checkExitCalls([{ to: POT, data: "0xdeadbeef" }], shown)).toEqual({ ok: false, problem: "call does not decode" });
  });
});

describe("both signing paths send exactly the checked exit", () => {
  const shown: ExitCall = { kind: "exit", pot: POT, shares: 10n ** 24n + 7n, to: FRIEND, own: false };

  test("passkey (user operation): the smart account's call data carries the checked call; a swapped destination does not", async () => {
    const calls = exitCalls(shown);
    const callData = (await encodeCallDataEpV07(calls.map((c) => ({ ...c, value: 0n })))) as Hex;
    expect(callDataCarries(callData, calls)).toBe(true);
    const swapped = (await encodeCallDataEpV07(exitCalls({ ...shown, to: OWN }).map((c) => ({ ...c, value: 0n })))) as Hex;
    expect(callDataCarries(swapped, calls)).toBe(false);
  });

  test("browser wallet: the transaction is the checked call itself, so its destination is the one shown", () => {
    const sent: { to: Address; data: Hex }[] = [];
    const wallet = { sendTransaction: (tx: { to: Address; data: Hex }) => sent.push(tx) }; // what the wallet signer is handed per call
    const calls = exitCalls(shown);
    expect(checkExitCalls(calls, shown)).toEqual({ ok: true });
    for (const c of calls) wallet.sendTransaction({ to: c.to, data: c.data });
    const d = decodeFunctionData({ abi: coferPotAbi, data: sent[0]!.data });
    expect(sent[0]!.to).toBe(POT);
    expect(d.functionName).toBe("exit");
    expect(d.args).toEqual([shown.shares, FRIEND]);
  });

  test("the page sends only the checked calls, on both paths", () => {
    const client = read("services/src/web/client.ts");
    const exitBranch = client.slice(client.indexOf('ex.purpose === "exit"'), client.indexOf('ex.purpose === "claim"'));
    expect(exitBranch).toContain("const calls = exitCalls(shownExit);");
    expect(exitBranch).toContain("checkExitCalls(calls, shownExit)");
    expect(exitBranch).toContain("await s.send!(calls)");
    // the passkey path checks the encoded user operation before it is sent
    expect(client).toMatch(/if \(!callDataCarries\(callData, calls\)\) throw new Stop/);
    expect(client.indexOf("callDataCarries(callData, calls)")).toBeLessThan(client.indexOf("client.sendUserOperation({ callData })"));
  });
});

describe("no link can carry a destination", () => {
  test("the page script never reads the address bar, a query string, the referrer or the fragment", () => {
    const client = read("services/src/web/client.ts");
    expect(client).not.toMatch(/\blocation\b|URLSearchParams|document\.URL|document\.referrer|\.hash\b|searchParams/);
  });

  test("the destination comes only from the typed field: the summary and the calls are built from chooseExitDestination(typed.value)", () => {
    const client = read("services/src/web/client.ts");
    expect(client).toContain('const typed = $("destAddr") as HTMLInputElement;');
    expect(client).toMatch(/chooseExitDestination\(\{ own: s\.address, open, typed: typed\.value,/);
    expect(client.match(/chooseExitDestination\(/g)!.length).toBe(1);
    // the link's ref is only the pot, and must be a plain address
    expect(client).toContain('if (!isAddress(pot)) throw new Stop("This exit link is not valid.');
  });

  test("the page settings have no destination, whatever the link looks like", () => {
    const html = signerPage(`tok?to=${FRIEND}#to=${FRIEND}`, { chainId: 46630, rpcUrl: "https://rpc.example", bundlerUrl: "", paymasterUrl: "", passkeyServerUrl: "", usdg: USDG, factory: FACTORY, adapter: ADAPTER });
    const json = JSON.parse(html.match(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/)![1]!.replace(/\\u003c/g, "<"));
    expect(Object.keys(json).sort()).toEqual(["adapter", "bundlerUrl", "chainId", "factory", "passkeyServerUrl", "paymasterUrl", "rpcUrl", "token", "usdg"]);
  });

  test("the dashboard's exit link request refuses any destination field", () => {
    expect(parseLinkRequest({ pot: POT, action: "exit" })).toEqual({ pot: POT, action: "exit" });
    for (const k of ["to", "destination", "dest", "recipient"]) expect(parseLinkRequest({ pot: POT, action: "exit", [k]: FRIEND })).toBeNull();
  });
});

describe("warnings", () => {
  const html = signerPage("tok", { chainId: 46630, rpcUrl: "https://rpc.example", bundlerUrl: "", paymasterUrl: "", passkeyServerUrl: "", usdg: USDG });
  const unesc = (s: string) => s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

  test("the texts are exactly as agreed", () => {
    expect(EXIT_NETWORK_WARNING).toBe(
      "This sends USDG and Stock Tokens on Robinhood Chain only. The address must be a wallet you control that supports Robinhood Chain. Do NOT use an exchange deposit address unless it clearly supports Robinhood Chain USDG: otherwise the funds are lost and cannot be recovered.",
    );
    expect(EXIT_CONFIRM_TEXT).toBe("I checked this address supports Robinhood Chain and is mine. Sending to a wrong address cannot be undone.");
    expect(PASSKEY_LOSS_WARNING).toBe(
      "Your passkey is your key. There is no recovery: if you lose it and have no backup, you lose access to your funds, like a lost seed phrase. Make sure your phone or browser backs up your passkeys (for example iCloud Keychain or Google Password Manager).",
    );
  });

  test("the exit option is collapsed and hidden by default; the network warning is above the field and again next to the checkbox", () => {
    const page = unesc(html);
    expect(page).toMatch(/<details id="dest" hidden>/);
    expect(page).not.toMatch(/<details[^>]* open/);
    const block = page.slice(page.indexOf('<details id="dest"'), page.indexOf("</details>"));
    expect(block).toContain(`<summary>${EXIT_TOGGLE_TEXT}</summary>`);
    const first = block.indexOf(EXIT_NETWORK_WARNING);
    const second = block.indexOf(EXIT_NETWORK_WARNING, first + 1);
    expect(first).toBeGreaterThan(-1);
    expect(first).toBeLessThan(block.indexOf('id="destAddr"'));
    expect(second).toBeGreaterThan(block.indexOf('id="destAddr"'));
    expect(block.slice(second)).toContain(`<input type="checkbox" id="destOk" class="check"> <small>${EXIT_CONFIRM_TEXT}</small>`);
  });

  test("the button stays off until a valid different address is typed and the box is ticked", () => {
    const client = read("services/src/web/client.ts");
    expect(client).toContain("act.disabled = !t || !!problem || !confirmed.checked;");
  });

  test("the lost-passkey warning is on the sign-up screen before the passkey is created, and in SECURITY.md and the runbook", () => {
    expect(unesc(html)).toContain(`<p id="keywarn" class="warn" hidden>${PASSKEY_LOSS_WARNING}</p>`);
    const client = read("services/src/web/client.ts");
    const onboard = client.slice(client.indexOf('if (ex.purpose === "onboard") {'));
    expect(onboard.indexOf('$("keywarn").hidden = false')).toBeGreaterThan(-1);
    expect(onboard.indexOf('$("keywarn").hidden = false')).toBeLessThan(onboard.indexOf("getSigner(true)"));
    expect(read("SECURITY.md")).toContain(PASSKEY_LOSS_WARNING);
    expect(read("docs/runbook.md")).toContain(PASSKEY_LOSS_WARNING);
  });
});
