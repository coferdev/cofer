/**
 * Signer site (browser bundle, built by Bun.build at server start). Opened from Telegram `url`
 * buttons in the system/in-app browser. It is NOT a Telegram Mini App.
 *
 * Member key = ZeroDev Kernel v3.1 smart account with the passkey (WebAuthn) validator 0.0.3,
 * verified on-chain via the RIP-7212 P-256 precompile (live on Robinhood Chain). Gas is sponsored
 * by the paymaster. Members can also use an injected EOA wallet.
 *
 * (U) Verify toWebAuthnKey's passkey-server flow and the validator address resolution against the
 *     pinned @zerodev versions during milestone M5 on RHC testnet 46630.
 */
import "./buffer-polyfill";
import { createPublicClient, createWalletClient, custom, encodeFunctionData, http, type Address, type Hex } from "viem";
import { createKernelAccount, createKernelAccountClient, createZeroDevPaymasterClient } from "@zerodev/sdk";
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";
import { toPasskeyValidator, PasskeyValidatorContractVersion } from "@zerodev/passkey-validator";
import { toWebAuthnKey, WebAuthnMode } from "@zerodev/webauthn-key";
import { coferPotAbi } from "../chain/abi";
import { signerProblem } from "../core/signerCheck";
import { failureText, isHandOff, ServerSaid } from "../core/retryText";
import { capRefusal, navReadFailureText, roomText } from "../core/betaCap";
import { DEPOSITS_CLOSED_TEXT, readDepositGate } from "../core/depositGate";
import { checkBeforeSign, pageSummary, tokensOf, VOTE_MISMATCH_TEXT, type ServerTypedData } from "../core/signCheck";
import { typedData, type ProposalEnvelope, type TokenMeta } from "../core/proposal";
import { CONFIG_ELEMENT_ID } from "./pageConfig";

declare global {
  interface Window {
    ethereum?: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };
  }
}

type PageConfig = { chainId: number; rpcUrl: string; bundlerUrl: string; paymasterUrl: string; passkeyServerUrl: string; usdg: Address; factory?: Address; token: string };

// Settings come from a JSON data block (never executed), so the page needs no inline script (CSP script-src 'self').
const cfg = JSON.parse(document.getElementById(CONFIG_ELEMENT_ID)!.textContent!) as PageConfig;

// Passkeys do not work in Telegram's in-app browser, so phones get a hint to open the page in their browser.
(() => {
  const n = navigator;
  const phone = /Android|iPhone|iPad|iPod|Mobile/i.test(n.userAgent) || (n.platform === "MacIntel" && n.maxTouchPoints > 1);
  if (!phone) return;
  const box = document.getElementById("notice")!;
  const ok = document.getElementById("notice-ok")!;
  box.hidden = false;
  ok.focus();
  ok.onclick = () => (box.hidden = true);
})();
const chain = {
  id: cfg.chainId,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [cfg.rpcUrl] } },
} as const;
const publicClient = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
const entryPoint = getEntryPoint("0.7");
const $ = (id: string) => document.getElementById(id)!;
const say = (t: string) => ($("status").textContent = t);

// Set once the current attempt has handed something to the bundler or the wallet. From then on it may land on-chain.
let handedOff = false;

let session = "";
async function trpc<T>(path: string, input: unknown, mutation = false): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (session) headers.authorization = `Bearer ${session}`;
  const res = mutation
    ? await fetch(`/trpc/${path}`, { method: "POST", headers, body: JSON.stringify(input) })
    : await fetch(`/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`, { headers });
  const json = await res.json();
  if (json.error) throw new ServerSaid(json.error.message ?? "request failed");
  return json.result.data as T;
}

async function passkeyAccount(mode: WebAuthnMode) {
  const webAuthnKey = await toWebAuthnKey({ passkeyName: "Cofer", passkeyServerUrl: cfg.passkeyServerUrl, mode });
  const validator = await toPasskeyValidator(publicClient, {
    webAuthnKey,
    entryPoint,
    kernelVersion: KERNEL_V3_1,
    validatorContractVersion: PasskeyValidatorContractVersion.V0_0_3_PATCHED,
  });
  const account = await createKernelAccount(publicClient, { plugins: { sudo: validator }, entryPoint, kernelVersion: KERNEL_V3_1 });
  const client = createKernelAccountClient({
    account,
    chain,
    // marks the hand-off as the user operation leaves for the bundler (after the passkey has signed it)
    bundlerTransport: http(cfg.bundlerUrl, {
      onFetchRequest: (_req, init) => {
        if (isHandOff(init.body)) handedOff = true;
      },
    }),
    paymaster: createZeroDevPaymasterClient({ chain, transport: http(cfg.paymasterUrl) }),
    client: publicClient,
  });
  return { account, client };
}

type Signer = {
  address: Address;
  signTypedData: (td: any) => Promise<Hex>;
  signMessage: (m: string) => Promise<Hex>;
  send?: (calls: { to: Address; data: Hex }[]) => Promise<Hex>;
};

async function getSigner(register = false): Promise<Signer> {
  if ((document.getElementById("useWallet") as HTMLInputElement | null)?.checked && window.ethereum) {
    const wallet = createWalletClient({ chain, transport: custom(window.ethereum) });
    const [address] = await wallet.requestAddresses();
    return {
      address: address!,
      signTypedData: (td) => wallet.signTypedData({ account: address!, ...td }),
      signMessage: (m) => wallet.signMessage({ account: address!, message: m }),
      send: async (calls) => {
        let last: Hex = "0x";
        for (const c of calls) {
          handedOff = true;
          last = await wallet.sendTransaction({ account: address!, to: c.to, data: c.data, chain });
        }
        return last;
      },
    };
  }
  const { account, client } = await passkeyAccount(register ? WebAuthnMode.Register : WebAuthnMode.Login);
  return {
    address: account.address,
    signTypedData: (td) => account.signTypedData(td),
    signMessage: (m) => account.signMessage({ message: m }),
    send: async (calls) => {
      const hash = await client.sendUserOperation({ callData: await account.encodeCalls(calls.map((c) => ({ ...c, value: 0n }))) });
      const r = await client.waitForUserOperationReceipt({ hash });
      return r.receipt.transactionHash;
    },
  };
}

/** A stop the member should read as is (not wrapped in "Something went wrong"). */
/** `detail` (optional) is the exact reason, recorded in this browser's console only; members read `message`. */
class Stop extends Error {
  constructor(message: string, readonly detail?: string) {
    super(message);
  }
}

/**
 * Shows a failure. Members only ever read a Stop or failureText's safe text. The page's single
 * console call records the full original error, or a Stop's detail when it has one (a plain Stop
 * is not console noise). Nothing is sent anywhere.
 */
function showFailure(e: unknown, handedOff: boolean) {
  const logged = e instanceof Stop ? e.detail : e;
  if (logged !== undefined) console.error("[cofer signer]", logged);
  say(e instanceof Stop ? e.message : failureText(e, handedOff));
}

/** Signer for a member action: the picked key must be the one linked to this Telegram user. Nothing is signed or sent before this check. */
async function memberSigner(): Promise<Signer> {
  const s = await getSigner();
  const me = await trpc<{ address: string | null } | undefined>("me.get", {});
  const problem = signerProblem(me?.address, s.address);
  if (problem) throw new Stop(problem);
  return s;
}

const IS_POT_ABI = [{ type: "function", name: "isPot", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] }] as const;
const TOKEN_META_ABI = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

/**
 * Checks a vote before any passkey prompt (core/signCheck.ts), then confirms on-chain that the
 * contract being signed for is a real Cofer pot. Returns the envelope to sign and the summary the
 * page renders from those exact bytes. Any mismatch stops with VOTE_MISMATCH_TEXT; nothing is signed.
 */
async function verifyVote(id: Hex): Promise<{ envelope: ProposalEnvelope; summary: string }> {
  const p = await trpc<{ typedData: ServerTypedData; action: unknown }>("proposal.get", { id });
  const check = checkBeforeSign({ typedData: p.typedData, serverAction: p.action, expectedDigest: id, chainId: cfg.chainId, nowSec: Math.floor(Date.now() / 1000) });
  if (!check.ok) throw new Stop(VOTE_MISMATCH_TEXT, `vote check failed: ${check.problem}`);
  if (!cfg.factory) throw new Stop(VOTE_MISMATCH_TEXT, "vote check failed: the page has no factory address");
  const isPot = await publicClient.readContract({ address: cfg.factory, abi: IS_POT_ABI, functionName: "isPot", args: [check.envelope.pot] });
  if (!isPot) throw new Stop(VOTE_MISMATCH_TEXT, `vote check failed: ${check.envelope.pot} is not a Cofer pot`);
  const meta = new Map<string, TokenMeta>();
  for (const t of tokensOf(check.action)) {
    const [symbol, decimals] = await Promise.all([
      publicClient.readContract({ address: t, abi: TOKEN_META_ABI, functionName: "symbol" }),
      publicClient.readContract({ address: t, abi: TOKEN_META_ABI, functionName: "decimals" }),
    ]);
    meta.set(t.toLowerCase(), { symbol, decimals: Number(decimals) });
  }
  return { envelope: check.envelope, summary: pageSummary(check.action, (a) => meta.get(a.toLowerCase())!) };
}

// The one-time link is spent here, on the first tap only. A retry after an error reuses the session.
async function ensureSession() {
  if (session) return;
  const ex = await trpc<{ session: string }>("session.exchange", { token: cfg.token }, true);
  session = ex.session;
}

type Preview = {
  used: boolean;
  purpose: string;
  ref: string;
  proposal: { summary: string; approvals: number; required: number; stale: boolean } | null;
  linked: string | null;
};

async function main() {
  // read-only: opening the page (also in Telegram's in-app browser) does not use up the link
  const ex = await trpc<Preview>("session.preview", { token: cfg.token });
  if (ex.used) throw new Stop("link already used; tap the button in Telegram again");
  const act = $("action") as HTMLButtonElement;
  // the button stays off while working and after success; an error is shown and the button comes back for a retry.
  // For a money action, an error after the hand-off asks the member to check before trying again.
  const guard = (fn: () => Promise<void>, money = false) => async () => {
    act.disabled = true;
    handedOff = false;
    try {
      await ensureSession();
      await fn();
    } catch (e) {
      showFailure(e, money && handedOff);
      act.disabled = false;
    }
  };

  if (ex.purpose === "onboard" && ex.linked) {
    // never create a second passkey: each one is a different account
    $("title").textContent = "Set up your key";
    $("body").textContent = `You already have a Cofer key (${ex.linked}). Nothing to do here.`;
    act.hidden = true;
    return;
  }

  if (ex.purpose === "onboard") {
    $("title").textContent = "Set up your key";
    $("body").textContent = "Creates a passkey on this device. It controls your seat: votes, deposits and exits. Nobody else can use it.";
    act.textContent = "Create passkey";
    act.onclick = guard(async () => {
      say("Creating passkey...");
      const s = await getSigner(true);
      // deploy the account (sponsored) so ERC-1271 votes verify on-chain from day one
      if (s.send) await s.send([{ to: s.address, data: "0x" }]);
      const { message } = await trpc<{ message: string }>("me.linkMessage", {});
      const signature = await s.signMessage(message);
      await trpc("me.link", { address: s.address, signature, kind: s.send ? "kernel-passkey" : "eoa" }, true);
      say(`Done. Your key: ${s.address}. Go back to Telegram.`);
    });
    return;
  }

  if (ex.purpose === "sign" && ex.ref.startsWith("0x") && ex.proposal) {
    const pv = ex.proposal;
    const tally = `Approvals: ${pv.approvals}/${pv.required}${pv.stale ? "\nSettings changed: this vote can no longer pass." : ""}`;
    $("title").textContent = "Vote";
    $("body").textContent = `${pv.summary}\n\n${tally}`;
    // Two taps: first the page checks the vote and shows its own summary of the exact bytes; only then the passkey.
    const approve = (envelope: ProposalEnvelope) =>
      guard(async () => {
        say("Waiting for your passkey...");
        const s = await memberSigner();
        const signature = await s.signTypedData(typedData(envelope)); // built by this page, never the server's object
        const r = await trpc<any>("proposal.sign", { id: ex.ref, signer: s.address, signature }, true);
        say(r.ready ? (r.delaySeconds > 0 ? "Passed. It executes after the exit window." : "Passed. Executing now.") : `Signed. ${r.approvals}/${r.required}.`);
      });
    act.textContent = "Check this vote";
    act.onclick = guard(async () => {
      say("Checking the vote...");
      const v = await verifyVote(ex.ref as Hex);
      $("body").textContent = `You are signing:\n${v.summary}\n\nThe bot showed: ${pv.summary}\n\n${tally}`;
      say("Checked. Read it, then approve.");
      act.textContent = "Approve with my passkey";
      act.onclick = approve(v.envelope);
      act.disabled = false;
    });
    return;
  }

  const pot = (ex.ref.startsWith("spend:") ? ex.ref.slice(6) : ex.ref) as Address;
  if (ex.purpose === "deposit") {
    // the group's value as the contract prices deposits (beta limit); a failed read refuses, never guesses
    const readNav = async () => {
      try {
        const [nav] = (await publicClient.readContract({ address: pot, abi: coferPotAbi, functionName: "navUsdg" })) as readonly [bigint, bigint];
        return nav;
      } catch (err) {
        throw new Stop(navReadFailureText(err));
      }
    };
    $("title").textContent = "Deposit USDG";
    $("amount").hidden = false;
    act.textContent = "Deposit";
    readNav().then(
      (nav) => ($("body").textContent = roomText(nav) ?? ""),
      () => {}, // checked again on tap, which shows the reason
    );
    act.onclick = guard(async () => {
      const amount = BigInt(Math.round(Number(($("amount") as HTMLInputElement).value) * 1e6));
      // before the passkey is asked for: nothing is signed or sent if the deposit would pass the beta limit
      const refusal = capRefusal(amount, await readNav());
      if (refusal) throw new Stop(refusal);
      // deposits need a fresh price for every held stock (audit M-1): refused here, before the passkey
      if (cfg.factory) {
        const stale = await readDepositGate(publicClient as never, pot, cfg.factory);
        if (stale) throw new Stop(DEPOSITS_CLOSED_TEXT, `deposit refused: ${stale.asset} price is ${stale.ageSec}s old`);
      }
      const s = await memberSigner();
      const approve = encodeFunctionData({ abi: [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }], args: [pot, amount] });
      const deposit = encodeFunctionData({ abi: coferPotAbi, functionName: "deposit", args: [amount] });
      say("Confirm with your passkey...");
      const tx = await s.send!([{ to: cfg.usdg, data: approve }, { to: pot, data: deposit }]);
      say(`Deposited. tx ${tx}`);
    }, true);
  } else if (ex.purpose === "exit") {
    $("title").textContent = "Exit with your exact share";
    $("body").textContent = "You receive your share of every asset the group holds, as it is (USDG and stocks). No vote. Never paused.";
    act.textContent = "Exit everything";
    act.onclick = guard(async () => {
      const s = await memberSigner();
      const info = (await publicClient.readContract({ address: pot, abi: coferPotAbi, functionName: "memberInfo", args: [s.address] })) as { shares: bigint };
      const data = encodeFunctionData({ abi: coferPotAbi, functionName: "exit", args: [info.shares, s.address] });
      const tx = await s.send!([{ to: pot, data }]);
      say(`Exited. tx ${tx}`);
    }, true);
  } else if (ex.purpose === "claim") {
    $("title").textContent = "Claim a set-aside token";
    $("body").textContent =
      "If a token could not be sent to you when you exited (for example, its issuer had paused it), it was set aside for you. This sends it to you now. No vote needed. It does not exit or change your share.";
    act.textContent = "Claim";
    act.onclick = guard(async () => {
      const s = await memberSigner();
      const held = (await publicClient.readContract({ address: pot, abi: coferPotAbi, functionName: "heldAssets" })) as readonly Address[];
      const owed: Address[] = [];
      for (const a of held) {
        const amt = (await publicClient.readContract({ address: pot, abi: coferPotAbi, functionName: "owed", args: [a, s.address] })) as bigint;
        if (amt > 0n) owed.push(a);
      }
      if (owed.length === 0) throw new Stop("Nothing is set aside for you in this group.");
      // one claim per token, so a token that is still paused does not block the others
      const done: Hex[] = [];
      let firstError: unknown;
      for (const a of owed) {
        say(owed.length > 1 ? `Confirm claim ${done.length + 1} of ${owed.length} with your passkey...` : "Confirm with your passkey...");
        try {
          done.push(await s.send!([{ to: pot, data: encodeFunctionData({ abi: coferPotAbi, functionName: "claimOwed", args: [a, s.address] }) }]));
        } catch (e) {
          firstError ??= e;
        }
      }
      if (done.length === 0) throw firstError;
      const left = owed.length - done.length;
      say(`Claimed ${done.length} token${done.length === 1 ? "" : "s"}. tx ${done.join(", ")}${left ? `\n${left} could not be claimed yet (the token may still be paused). Try /claim again later.` : ""}`);
    }, true);
  } else if (ex.purpose === "sign" && ex.ref.startsWith("spend:")) {
    $("title").textContent = "Spend from your allowance";
    $("amount").hidden = false;
    $("to").hidden = false;
    act.textContent = "Send";
    act.onclick = guard(async () => {
      const amount = BigInt(Math.round(Number(($("amount") as HTMLInputElement).value) * 1e6));
      const to = ($("to") as HTMLInputElement).value as Address;
      const s = await memberSigner();
      const data = encodeFunctionData({ abi: coferPotAbi, functionName: "spend", args: [to, amount, "0x0000000000000000000000000000000000000000000000000000000000000000"] });
      const tx = await s.send!([{ to: pot, data }]);
      say(`Sent. tx ${tx}`);
    }, true);
  } else if (ex.purpose === "card") {
    $("title").textContent = "Load a card (optional)";
    $("amount").hidden = false;
    act.textContent = "Get quote";
    act.onclick = guard(async () => {
      const amount = BigInt(Math.round(Number(($("amount") as HTMLInputElement).value) * 1e6));
      const s = await memberSigner();
      const q = await trpc<any>("card.quote", { pot, amountUsdg: amount.toString() }, true);
      const data = encodeFunctionData({ abi: coferPotAbi, functionName: "spend", args: [q.fundingAddress, BigInt(q.amountUsdg), q.memo] });
      const tx = await s.send!([{ to: pot, data }]);
      const st = await trpc<any>("card.confirm", { orderId: q.orderId, spendTx: tx }, true);
      say(`Card order ${st.status}. Load fee ${Number(q.loadFeeUsdg) / 1e6} USDG.`);
    }, true);
  }
}

main().catch((e) => showFailure(e, false));
