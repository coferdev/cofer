/**
 * Connect wallet (Reown AppKit with the wagmi adapter, plain TypeScript). Built as its own bundle,
 * /assets/wallet.js, and loaded only on the wallet page (/w/:token): the passkey page never loads it.
 *
 * It only connects a wallet and hands back its EIP-1193 provider and address. Everything else (the
 * network check, the Kernel account, every check before signing) stays in client.ts.
 * Email, social logins, swaps, on-ramp and analytics are off: only real wallets connect.
 */
import { createAppKit, type AppKit } from "@reown/appkit";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { defineChain } from "@reown/appkit/networks";

export type WalletOpts = { projectId: string; chainId: number; chainName: string; rpcUrl: string };
export type Eip1193 = { request: (a: { method: string; params?: unknown }) => Promise<unknown> };
export type Connected = { address: `0x${string}`; provider: Eip1193 };

let kit: AppKit | undefined;
let network: ReturnType<typeof defineChain> | undefined;

function setup(o: WalletOpts): AppKit {
  if (kit) return kit;
  network = defineChain({
    id: o.chainId,
    caipNetworkId: `eip155:${o.chainId}`,
    chainNamespace: "eip155",
    name: o.chainName,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [o.rpcUrl] } },
  });
  const adapter = new WagmiAdapter({ projectId: o.projectId, networks: [network] });
  kit = createAppKit({
    adapters: [adapter],
    networks: [network],
    defaultNetwork: network,
    projectId: o.projectId,
    metadata: { name: "Cofer", description: "Cofer signer", url: location.origin, icons: [] },
    features: { analytics: false, email: false, socials: false, swaps: false, onramp: false, send: false, receive: false, history: false },
    allowUnsupportedChain: false,
    // no Coinbase/Base SDK loaded in the page (it injects its own telemetry script, which the page's
    // policy blocks anyway); Coinbase Wallet still connects through WalletConnect like any other wallet
    enableCoinbase: false,
    enableBaseAccount: false,
    themeMode: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  });
  return kit;
}

/** A closed wallet window reads like a wallet refusal (EIP-1193 code 4001): "cancelled". */
function cancelled(): Error {
  return Object.assign(new Error("wallet window closed"), { name: "UserRejectedRequestError", code: 4001 });
}

/** Opens the wallet window if no wallet is connected yet, and resolves once one is. */
export async function connect(o: WalletOpts): Promise<Connected> {
  const k = setup(o);
  if (!k.getIsConnectedState() || !k.getAddress("eip155")) {
    await new Promise<void>((resolve, reject) => {
      let opened = false;
      const stops: (() => void)[] = [];
      const done = (err?: Error) => {
        for (const s of stops) s();
        if (err) reject(err);
        else resolve();
      };
      stops.push(
        k.subscribeAccount((a) => {
          if (a.isConnected && a.address) done();
        }, "eip155"),
      );
      stops.push(
        k.subscribeState((s) => {
          if (s.open) opened = true;
          else if (opened && !k.getIsConnectedState()) done(cancelled());
        }),
      );
      void k.open({ view: "Connect" }).catch((e: unknown) => done(e instanceof Error ? e : cancelled()));
    });
  }
  // ask the wallet for the page's network (AppKit adds it if the wallet does not know it); client.ts checks again
  if (network && Number(k.getChainId()) !== o.chainId) await k.switchNetwork(network).catch(() => {});
  const address = k.getAddress("eip155") as `0x${string}` | undefined;
  const provider = k.getWalletProvider() as Eip1193 | undefined;
  if (!address || !provider) throw cancelled();
  await k.close().catch(() => {});
  return { address, provider };
}

/** Forgets the connected wallet (used after a wrong wallet, so the next tap can pick another). */
export async function disconnect(): Promise<void> {
  await kit?.disconnect().catch(() => {});
}
