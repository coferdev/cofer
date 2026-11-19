import { describe, expect, test } from "bun:test";
import { encodeAbiParameters, encodeEventTopics, getAddress, type Abi, type Address, type Hex } from "viem";
import recorded from "./fixtures/tx-receipts-46630.json";
import { coferFactoryAbi, coferPotAbi, feeRouterAbi } from "../src/chain/abi";
import { explainReceipt, type TxReceiptLike } from "../src/core/txExplain";
import { fakeTx, recordedReceipt } from "./publicApiHarness";

const d = fakeTx().explain;
const POT = "0x50F19AdD1EE10AF538C1F8bE5bcbA4011F100115" as Address;
const USDG = "0x14119629e364A53ceda500d0c1111DBB136A7398" as Address;
const TSTA = "0x3232ddde4c6a3fe39fd17696791d50b54bc52ffe" as Address;
const M = "0xD6D8195a52Fa752A5bBaf76b598336FecAc9c585" as Address;
const explain = (hash: string) => {
  const r = recordedReceipt(hash);
  return explainReceipt(r, d, r.blockTime);
};

/** A log built with the contract's own ABI, for event kinds no testnet transaction has emitted yet. */
function logOf(abi: Abi, address: Address, eventName: string, args: Record<string, unknown>, logIndex = 0) {
  const ev = abi.find((x) => x.type === "event" && x.name === eventName) as unknown as { inputs: { name: string; type: string; indexed?: boolean }[] };
  const topics = encodeEventTopics({ abi, eventName, args } as never) as Hex[];
  const data = encodeAbiParameters(ev.inputs.filter((i) => !i.indexed) as never, ev.inputs.filter((i) => !i.indexed).map((i) => args[i.name]) as never);
  return { address, topics, data, logIndex };
}
const built = (logs: ReturnType<typeof logOf>[], to: Address = POT, status: "success" | "reverted" = "success"): TxReceiptLike => ({ transactionHash: `0x${"ab".repeat(32)}`, blockNumber: 1n, status, from: M, to, logs });

describe("transaction explainer: recorded testnet receipts", () => {
  test("a deposit, through the EntryPoint: token and EntryPoint logs left out", async () => {
    const e = await explain(recorded.kinds.Deposited);
    expect(e.cofer).toBe(true);
    expect(e.kind).toBe("deposit");
    expect(e.events.map((x) => x.event)).toEqual(["Deposited"]);
    expect(e.summary).toBe("A Cofer deposit: 0xD6D8195a52Fa752A5bBaf76b598336FecAc9c585 deposited 100 USDG into group account 0x50F19AdD1EE10AF538C1F8bE5bcbA4011F100115 and received 100 shares.");
    expect(e.time).toBe(recorded.receipts.find((r) => r.transactionHash === recorded.kinds.Deposited)!.blockTime);
  });

  test("an exit: shares and every amount paid out, with the destination", async () => {
    const e = await explain(recorded.kinds.Exited);
    expect(e.kind).toBe("exit");
    expect(e.events[0]!.text).toBe("0xD6D8195a52Fa752A5bBaf76b598336FecAc9c585 exited group account 0x50F19AdD1EE10AF538C1F8bE5bcbA4011F100115 with 100 shares, paid out to 0xD6D8195a52Fa752A5bBaf76b598336FecAc9c585: 90 USDG.");
  });

  test("a vote that ran: the send and the vote", async () => {
    const e = await explain(recorded.kinds.ProposalExecuted);
    expect(e.kind).toBe("vote executed");
    expect(e.events.map((x) => x.text)).toEqual([
      "Group account 0x50F19AdD1EE10AF538C1F8bE5bcbA4011F100115 sent 10 USDG to 0xD6D8195a52Fa752A5bBaf76b598336FecAc9c585, as voted.",
      "A vote to send ran in group account 0x50F19AdD1EE10AF538C1F8bE5bcbA4011F100115, with 1 approval(s). Vote id 0xf0652e2a83bc8a4204b069fb553b29da259c60327bf4fa42451e66288d6e2987.",
    ]);
  });

  test("a queued vote names the exit window's end", async () => {
    const e = await explain(recorded.kinds.ProposalQueued);
    expect(e.kind).toBe("vote queued");
    expect(e.summary).toContain("waits for the exit window: it can run after 2026-11-08 00:53 UTC. Members who disagree can exit before then.");
  });

  test("an allowance spend and what is left", async () => {
    const e = await explain(recorded.kinds.AllowanceSpent);
    expect(e.kind).toBe("allowance spend");
    expect(e.events[0]!.text).toContain("spent 2 USDG of their allowance");
    expect(e.events[0]!.text).toContain("Left this period: 3 USDG.");
  });

  test("a group created: the factory's PotCreated is the summary", async () => {
    const e = await explain(recorded.kinds.PotCreated);
    expect(e.kind).toBe("group created");
    expect(e.summary).toBe("A Cofer group created: The factory created group account 0xdbcfA82678A63c58173379eD177890768e28E991 for creator 0x9A2f1dB52584bF83cf6018cb928A52865952E43f, with 1 member(s); a vote needs 60% of members to approve (rounded up).");
    expect(e.events.map((x) => x.event)).toEqual(["MemberAdded", "ThresholdSet", "ConfigSet", "Initialized", "PotCreated"]);
  });

  test("admin changes on the factory and the fee router", async () => {
    expect((await explain(recorded.kinds.SwapFeeSet)).events.map((x) => x.text)).toEqual([
      "The factory's owner changed from 0x0000000000000000000000000000000000000000 to 0x6511f9e4002ae8126504Fa23A64C533579d23817.",
      "The factory's guardian is now 0x7948f5AE3c874505a4F92C3A09bc952A17C745f1.",
      "The swap fee is now 0.3%.",
    ]);
    expect((await explain(recorded.kinds.PlanPriceSet)).events[1]!.text).toBe("The plan price is now 9 USDG a month.");
    expect((await explain(recorded.kinds.AdapterQueued)).summary).toContain("It can be turned on after 2026-11-04 12:59 UTC.");
  });

  test("every recorded receipt is explained, and every Cofer log in it is named", async () => {
    for (const r of recorded.receipts) {
      const e = await explain(r.transactionHash);
      expect(e.cofer).toBe(true);
      expect(e.events.every((x) => x.event && x.text && !x.text.includes("undefined"))).toBe(true);
    }
  });

  test("the same logs without a Cofer contract: not a Cofer transaction", async () => {
    const r = recordedReceipt(recorded.kinds.Deposited);
    const other = { ...r, to: "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as Address, logs: r.logs.filter((l) => l.address.toLowerCase() !== POT.toLowerCase()) };
    const e = await explainReceipt(other, d);
    expect(e).toMatchObject({ cofer: false, kind: null, events: [], summary: "Not a Cofer transaction: none of its logs come from a Cofer contract." });
  });
});

describe("transaction explainer: event kinds built with the contracts' ABI", () => {
  test("a swap: both amounts and the fee", async () => {
    const e = await explainReceipt(built([logOf(coferPotAbi, POT, "Swapped", { adapter: "0x522979FeE39C148FF181404BABb0dc78D427F3ec", tokenIn: USDG, tokenOut: TSTA, amountIn: 50_000_000n, fee: 150_000n, amountOut: 2n * 10n ** 17n })]), d);
    expect(e.summary).toBe("A Cofer swap: Group account 0x50F19AdD1EE10AF538C1F8bE5bcbA4011F100115 swapped 50 USDG for 0.2 TSTA through adapter 0x522979FeE39C148FF181404BABb0dc78D427F3ec (swap fee 0.15 USDG).");
  });

  test("set aside during an exit, then claimed", async () => {
    const owed = await explainReceipt(built([logOf(coferPotAbi, POT, "ExitOwed", { asset: TSTA, account: M, amount: 10n ** 18n })]), d);
    expect(owed.events[0]!.text).toBe("1 TSTA could not be sent to 0xD6D8195a52Fa752A5bBaf76b598336FecAc9c585 during the exit, so it was set aside for them to claim later.");
    const claim = await explainReceipt(built([logOf(coferPotAbi, POT, "OwedClaimed", { asset: TSTA, account: M, amount: 10n ** 18n })]), d);
    expect(claim.kind).toBe("claim");
  });

  test("plan payment on the pot and the fee router; fee distribution; pauses", async () => {
    const router = recorded.feeRouter as Address;
    const plan = await explainReceipt(built([logOf(coferPotAbi, POT, "PlanPaid", { months: 3, cost: 27_000_000n }), logOf(feeRouterAbi, router, "PlanPaid", { pot: POT, months: 3, cost: 27_000_000n, paidUntil: 1_800_000_000n }, 1)]), d);
    expect(plan.events.map((x) => x.text)).toEqual(["Group account 0x50F19AdD1EE10AF538C1F8bE5bcbA4011F100115 paid the plan for 3 month(s): 27 USDG.", "The fee router recorded a plan payment from group account 0x50F19AdD1EE10AF538C1F8bE5bcbA4011F100115: 3 month(s), 27 USDG, paid until 2027-01-15 08:00 UTC."]);
    const dist = await explainReceipt(built([logOf(feeRouterAbi, router, "Distributed", { token: USDG, total: 1_000_000n })], router), d);
    expect(dist.summary).toBe("A Cofer fee distribution: The fee router sent 1 USDG on to the four fee wallets.");
    const paused = await explainReceipt(built([logOf(coferFactoryAbi, recorded.factory as Address, "DepositsPaused", { paused: true })], recorded.factory as Address), d);
    expect(paused.events[0]!.text).toBe("Deposits into every group account were paused. Exits are never paused.");
  });

  test("an unknown token is shown in raw units with its address, never guessed", async () => {
    const odd = "0x00000000000000000000000000000000000000ee" as Address;
    const e = await explainReceipt(built([logOf(coferPotAbi, POT, "Transferred", { asset: odd, to: M, amount: 12345n })]), d);
    expect(e.events[0]!.text).toBe(`Group account ${POT} sent 12345 raw units of token ${getAddress(odd)} to ${M}, as voted.`);
  });

  test("the vote rule reads as the pot counts it: a share of members when set, else the fixed count", async () => {
    const bps = await explainReceipt(built([logOf(coferPotAbi, POT, "ThresholdSet", { threshold: 2, thresholdBps: 6000 })]), d);
    expect(bps.events[0]!.text).toBe(`Group account ${POT} now needs 60% of members to approve (rounded up).`);
    const fixed = await explainReceipt(built([logOf(coferPotAbi, POT, "ThresholdSet", { threshold: 2, thresholdBps: 0 })]), d);
    expect(fixed.events[0]!.text).toBe(`Group account ${POT} now needs 2 approval(s).`);
  });

  test("a failed Cofer transaction says nothing took effect", async () => {
    const e = await explainReceipt(built([], POT, "reverted"), d);
    expect(e).toMatchObject({ cofer: true, status: "failed", kind: null, summary: "A Cofer transaction that failed on-chain: nothing in it took effect." });
  });

  test("a log from an address the factory did not make is left out", async () => {
    const fake = "0x00000000000000000000000000000000000000f1" as Address;
    const e = await explainReceipt(built([logOf(coferPotAbi, fake, "Deposited", { member: M, amount: 1n, shares: 1n, navBefore: 0n })], fake), d);
    expect(e.cofer).toBe(false);
  });
});
