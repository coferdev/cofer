/**
 * Connect wallet (Reown AppKit with the wagmi adapter, plain TypeScript). Built as its own bundle,
 * /assets/wallet.js, and loaded only on the wallet page (/w/:token): the passkey page never loads it.
 *
 * It only connects a wallet and hands back its EIP-1193 provider and address. Everything else (the
 * network check, the Kernel account, every check before signing) stays in client.ts.
 * Email, social logins, swaps, on-ramp and analytics are off: only real wallets connect.
 *
 * As many choices as possible: every browser wallet the person has installed is listed on its own,
 * by name (EIP-6963), then the WalletConnect list (well-known wallets first, then "all wallets"), so
 * phone wallets connect by QR code or deep link. Themed like the website: dark, Geist (the page's own
 * self-hosted font, so the window loads no font from Reown), light accent, rounded corners.
 */
import { createAppKit, type AppKit } from "@reown/appkit";
import { OptionsController } from "@reown/appkit-controllers";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { defineChain } from "@reown/appkit/networks";

export type WalletOpts = { projectId: string; chainId: number; chainName: string; rpcUrl: string };
export type Eip1193 = { request: (a: { method: string; params?: unknown }) => Promise<unknown> };
export type Connected = { address: `0x${string}`; provider: Eip1193 };

/**
 * Shown first in the WalletConnect list (Reown wallet registry ids, checked against the registry on
 * 2026-11-16): MetaMask, Trust Wallet, Rabby, OKX Wallet, Rainbow, Zerion, Uniswap Wallet, Ledger
 * Wallet, Base (Coinbase Wallet, connects through WalletConnect; its own SDK stays off). Every other
 * wallet in the registry is still listed under "all wallets".
 */
export const FEATURED_WALLET_IDS = [
  "c57ca95b47569778a828d19178114f4db188b89b763c899ba0be274e97267d96",
  "4622a2b2d6af1c9844944291e5e7351a6aa24cd7b23099efac1b2fd875da31a0",
  "18388be9ac2d02726dbac9777c96efaac06d744b2f6d580fccdd4127a6d01fd1",
  "971e689d0a5be527bac79629b4ee9b925e82208e5168b733496a09c0faed0709",
  "1ae92b26df02f0abca6304df07debccd18262fdf5fe82daa81593582dac9a369",
  "ecc4036f814562b41a5268adc86270fba1365471402006302e70169465b7ac18",
  "c03dfee351b6fcc421b4494ea33b9d4b92a984f87aa76d1663bb28705e95034a",
  "19177a98252e07ddfc9af2083ba8e07ef627cb6103467ffebb3f8f4205fd7927",
  "fd20dc426fb37566d803205b19bbc1d4096b248ac04548e3cfb6b3a38bd033aa",
];

/** The website's look for the wallet window: Geist (self-hosted by the page), light accent, dark panel. */
export const WALLET_THEME = {
  "--w3m-font-family": "Geist, Arial, sans-serif",
  "--w3m-accent": "#e4e4e1",
  "--w3m-color-mix": "#080808",
  "--w3m-color-mix-strength": 40,
  "--w3m-border-radius-master": "6px",
} as const;

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
  // AppKit 1.8.24 reads enableCoinbase from the options but never enableBaseAccount, so the Base
  // Account SDK (which injects its own telemetry script) would still load: switch it off here,
  // before the adapter adds its connectors.
  OptionsController.setEnableBaseAccount(false);
  const adapter = new WagmiAdapter({ projectId: o.projectId, networks: [network] });
  kit = createAppKit({
    adapters: [adapter],
    networks: [network],
    defaultNetwork: network,
    projectId: o.projectId,
    metadata: { name: "Cofer", description: "Cofer signer", url: location.origin, icons: [] },
    features: { analytics: false, email: false, socials: false, swaps: false, onramp: false, send: false, receive: false, history: false, allWallets: true },
    // every installed browser wallet by name, then the WalletConnect list (featured first, then all)
    enableEIP6963: true,
    enableInjected: true,
    enableWalletConnect: true,
    allWallets: "SHOW",
    featuredWalletIds: FEATURED_WALLET_IDS,
    allowUnsupportedChain: false,
    // no Coinbase/Base SDK loaded in the page (it injects its own telemetry script, which the page's
    // policy blocks anyway); Coinbase Wallet still connects through WalletConnect like any other wallet
    enableCoinbase: false,
    enableBaseAccount: false,
    themeMode: "dark",
    themeVariables: WALLET_THEME,
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
