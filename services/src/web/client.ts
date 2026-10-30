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

declare global {
  interface Window {
    COFER: { chainId: number; rpcUrl: string; bundlerUrl: string; paymasterUrl: string; passkeyServerUrl: string; usdg: Address; token: string };
    ethereum?: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };
  }
}

const cfg = window.COFER;
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

let session = "";
async function trpc<T>(path: string, input: unknown, mutation = false): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (session) headers.authorization = `Bearer ${session}`;
  const res = mutation
    ? await fetch(`/trpc/${path}`, { method: "POST", headers, body: JSON.stringify(input) })
    : await fetch(`/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`, { headers });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message ?? "request failed");
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
    bundlerTransport: http(cfg.bundlerUrl),
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
        for (const c of calls) last = await wallet.sendTransaction({ account: address!, to: c.to, data: c.data, chain });
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

function reviveTypedData(td: any) {
  return { ...td, message: { ...td.message, nonce: BigInt(td.message.nonce), epoch: BigInt(td.message.epoch), deadline: BigInt(td.message.deadline) } };
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
};

async function main() {
  // read-only: opening the page (also in Telegram's in-app browser) does not use up the link
  const ex = await trpc<Preview>("session.preview", { token: cfg.token });
  if (ex.used) throw new Error("link already used; tap the button in Telegram again");
  const act = $("action") as HTMLButtonElement;
  // the button stays off while working and after success; an error is shown and the button comes back for a retry
  const guard = (fn: () => Promise<void>) => async () => {
    act.disabled = true;
    try {
      await ensureSession();
      await fn();
    } catch (e: any) {
      say(`Something went wrong: ${String(e?.message ?? e)}. You can try again.`);
      act.disabled = false;
    }
  };

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
    $("title").textContent = "Vote";
    $("body").textContent = `${pv.summary}\n\nApprovals: ${pv.approvals}/${pv.required}${pv.stale ? "\nSettings changed: this vote can no longer pass." : ""}`;
    act.textContent = "Approve with my passkey";
    act.onclick = guard(async () => {
      const p = await trpc<any>("proposal.get", { id: ex.ref });
      say("Waiting for your passkey...");
      const s = await getSigner();
      const signature = await s.signTypedData(reviveTypedData(p.typedData));
      const r = await trpc<any>("proposal.sign", { id: ex.ref, signer: s.address, signature }, true);
      say(r.ready ? (r.delaySeconds > 0 ? "Passed. It executes after the exit window." : "Passed. Executing now.") : `Signed. ${r.approvals}/${r.required}.`);
    });
    return;
  }

  const pot = (ex.ref.startsWith("spend:") ? ex.ref.slice(6) : ex.ref) as Address;
  if (ex.purpose === "deposit") {
    $("title").textContent = "Deposit USDG";
    act.textContent = "Deposit";
    act.onclick = guard(async () => {
      const amount = BigInt(Math.round(Number(($("amount") as HTMLInputElement).value) * 1e6));
      const s = await getSigner();
      const approve = encodeFunctionData({ abi: [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }], args: [pot, amount] });
      const deposit = encodeFunctionData({ abi: coferPotAbi, functionName: "deposit", args: [amount] });
      say("Confirm with your passkey...");
      const tx = await s.send!([{ to: cfg.usdg, data: approve }, { to: pot, data: deposit }]);
      say(`Deposited. tx ${tx}`);
    });
  } else if (ex.purpose === "exit") {
    $("title").textContent = "Exit with your exact share";
    $("body").textContent = "You receive your share of every asset the group holds, as it is (USDG and stocks). No vote. Never paused.";
    act.textContent = "Exit everything";
    act.onclick = guard(async () => {
      const s = await getSigner();
      const info = (await publicClient.readContract({ address: pot, abi: coferPotAbi, functionName: "memberInfo", args: [s.address] })) as { shares: bigint };
      const data = encodeFunctionData({ abi: coferPotAbi, functionName: "exit", args: [info.shares, s.address] });
      const tx = await s.send!([{ to: pot, data }]);
      say(`Exited. tx ${tx}`);
    });
  } else if (ex.purpose === "sign" && ex.ref.startsWith("spend:")) {
    $("title").textContent = "Spend from your allowance";
    act.textContent = "Send";
    act.onclick = guard(async () => {
      const amount = BigInt(Math.round(Number(($("amount") as HTMLInputElement).value) * 1e6));
      const to = ($("to") as HTMLInputElement).value as Address;
      const s = await getSigner();
      const data = encodeFunctionData({ abi: coferPotAbi, functionName: "spend", args: [to, amount, "0x0000000000000000000000000000000000000000000000000000000000000000"] });
      const tx = await s.send!([{ to: pot, data }]);
      say(`Sent. tx ${tx}`);
    });
  } else if (ex.purpose === "card") {
    $("title").textContent = "Load a card (optional)";
    act.textContent = "Get quote";
    act.onclick = guard(async () => {
      const amount = BigInt(Math.round(Number(($("amount") as HTMLInputElement).value) * 1e6));
      const q = await trpc<any>("card.quote", { pot, amountUsdg: amount.toString() }, true);
      const s = await getSigner();
      const data = encodeFunctionData({ abi: coferPotAbi, functionName: "spend", args: [q.fundingAddress, BigInt(q.amountUsdg), q.memo] });
      const tx = await s.send!([{ to: pot, data }]);
      const st = await trpc<any>("card.confirm", { orderId: q.orderId, spendTx: tx }, true);
      say(`Card order ${st.status}. Load fee ${Number(q.loadFeeUsdg) / 1e6} USDG.`);
    });
  }
}

main().catch((e) => say(String(e?.message ?? e)));
