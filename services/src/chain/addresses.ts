import { getAddress, type Address } from "viem";

/**
 * Robinhood Chain mainnet (4663). Verified on-chain / in primary docs 2026-10-25.
 * Re-verify anything older than 30 days before a deploy.
 */
export const RHC = {
  chainId: 4663,
  testnetChainId: 46630,
  USDG: getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"), // 6 dp, EIP-2612 + EIP-3009
  WETH: getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"),
  PERMIT2: getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3"),
  UNI_V3_FACTORY: getAddress("0x1f7d7550b1b028f7571e69a784071f0205fd2efa"),
  UNI_V3_SWAP_ROUTER_02: getAddress("0xcaf681a66d020601342297493863e78c959e5cb2"),
  UNI_V3_QUOTER_V2: getAddress("0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7"),
  UNI_V4_POOL_MANAGER: getAddress("0x8366a39cc670b4001a1121b8f6a443a643e40951"),
  UNI_V4_QUOTER: getAddress("0x8dc178efb8111bb0973dd9d722ebeff267c98f94"),
  UNIVERSAL_ROUTER: getAddress("0x8876789976decbfcbbbe364623c63652db8c0904"),
  MULTICALL3: getAddress("0xcA11bde05977b3631167028862bE2a173976CA11"),
  ENTRYPOINT_V07: getAddress("0x0000000071727De22E5E9d8BAf0edAc6f37da032"),
  KERNEL_V3_1_FACTORY: getAddress("0xaac5D4240AF87249B3f71BC8E4A2cae074A3E419"),
  ZERODEV_PASSKEY_VALIDATOR_0_0_3: getAddress("0x7ab16Ff354AcB328452F1D445b3Ddee9a91e9e69"),
  RIP7212_P256: getAddress("0x0000000000000000000000000000000000000100"),
} as const satisfies Record<string, Address | number>;

/** Chainlink feeds on RHC (8 dp). Equity feeds ALREADY include the Stock Token multiplier. */
export const FEEDS: Record<string, Address> = {
  USDG: getAddress("0x8bEeE3503F6860D5dac4cE26b5eEe92982951c2e"),
  ETH: getAddress("0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9"),
  AAPL: getAddress("0xBb11A21267cFDb63d4935d99a499133DD1744ACb"),
  TSLA: getAddress("0x7A6b81ba7FbCB90104d8C496158Cf383cD7233b1"),
  NVDA: getAddress("0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15"),
  SPY: getAddress("0x78BCB218fA04B9b3a278eBc865Ed320BF8DEFBAc"),
};

/** Issuer's public Stock Token API (no auth, 60 req/s). Canonical addresses come ONLY from here. */
export const STOCK_API = "https://api.robinhood.com/rhj";
