# Cofer (working name)

A shared group money account on Robinhood Chain (4663), run from a Telegram group chat.

- `contracts/`: Solidity 0.8.28, dependency-free (minimal libs vendored). `CoferPot` (one EIP-1167 clone per group), `CoferFactory` (registry + timelocked admin), `UniV3SwapAdapter`, `FeeRouter`, mocks, forge-style tests, `script/Deploy.s.sol`.
- `services/`: Bun + Hono + tRPC v11 + Drizzle (Postgres) + BullMQ + viem + grammY. Plain Telegram bot, signer site + API, relayer, indexer, keeper, notifier, card adapter interface + stub.
- `tools/banned-words.ts`: CI gate for banned marketing words.
- `docs/`: [architecture and roles](docs/architecture.md), [invariants and their tests](docs/invariants.md), [threat model](docs/threat-model.md), [pause runbook](docs/runbook.md). Security contact and open issues: [SECURITY.md](SECURITY.md).

## Verify

```bash
# contracts, without Foundry (solc-js 0.8.28)
cd contracts && npm i && npm run compile:solcjs     # compiles src + test + script, exports ABIs to services/
npm run test:hardhat                                 # runs the *.t.sol suite under Hardhat 3
# or, with Foundry installed
forge test -vv

# services
cd services && bun install && bun run typecheck && bun test

# whole repo
bun tools/banned-words.ts .
```

## Rules the code enforces

1. **Exit is never gated.** `exit`/`leave` have no pause, vote or oracle. Each member receives `floor(balance x shares / totalShares)` of every held asset. A token that refuses the transfer is set aside for the member (`claimOwed`).
2. **Votes are signatures.** Each vote is an EIP-712 signature from the member's own key (passkey smart account through ERC-1271, or an EOA). Execution is permissionless. A non-unanimous passed vote waits `guardDelay` so anyone who disagrees can exit first. Swaps are the exception: the assets stay in the pot, and an oracle floor bounds the price.
3. **The contracts give the studio no way to move a pot's funds.** The studio holds two roles. The **owner** of `CoferFactory` and `FeeRouter` is a 2-of-3 Safe multisig on Robinhood Chain (`0x5ACD09eAe4f160e2f2e2356e6eF0496EF6f0f064`). It can pause new deposits and new pots, list or delist buyable assets, and replace the guardian. Feed, swap-adapter and swap-fee changes are timelocked for 48h. The **guardian** is a single wallet that can only pause or unpause new deposits and new pots. Swap fees and plan payments go to `FeeRouter`, and all four of its fee sinks are that same single wallet. Two limits (see [SECURITY.md](SECURITY.md)): the optional group-plan price is not timelocked yet, and the signer site the studio runs decides what each passkey is asked to sign.
4. **Feeds already include the Stock Token multiplier.** Value = raw balance x feed answer, and the multiplier is never applied a second time.
5. **Plain bot.** The bot has no Mini App and no `web_app` buttons (enforced by test). Signing happens on an external site opened with `url` buttons.

## Deploy (from a fresh clone)

Run each command on its own line. Do testnet first; mainnet only after it works end to end.

### 0. What you need

- Foundry (`forge`, `cast`) and Bun.
- Postgres and Redis for the services.
- A Telegram bot token (from BotFather) and an HTTPS address for the signer site.
- A ZeroDev project: bundler, paymaster and passkey server URLs.
- A Robinhood Chain RPC URL (`RHC_RPC`).
- The owner Safe (2-of-3, `0x5ACD09eAe4f160e2f2e2356e6eF0496EF6f0f064`) and the guardian wallet, which also receives fees.
- A **fresh** deployer key with a little ETH for gas. It is used once; after hand-off it holds no role.

### 1. Clone and check

```bash
git clone https://github.com/coferdev/cofer.git && cd cofer
cd contracts && forge build --sizes --skip script && forge test -vv && cd ..
cd services && bun install --frozen-lockfile && bun run typecheck && bun test && cd ..
bun tools/banned-words.ts .
```

### 2. Contracts on testnet (46630)

`DeployTestnet.s.sol` deploys the repo's own mocks (USDG, two Stock Tokens, feeds, router) and refuses any other chain.

```bash
cd contracts
read -rs DEPLOYER_KEY && export DEPLOYER_KEY   # paste the 0x... key, press Enter; nothing is shown or saved in history
export MULTISIG=0x... GUARDIAN=0x... SINK_WORK=0x... SINK_TREASURY=0x... SINK_PERKS=0x... SINK_BURN=0x...
forge script script/DeployTestnet.s.sol --rpc-url robinhood_testnet --broadcast
unset DEPLOYER_KEY
```

The new addresses are printed and saved under `contracts/broadcast/` (git-ignored).

### 3. Contracts on mainnet (4663)

Same steps with `Deploy.s.sol`. It deploys `CoferPot` (implementation), `FeeRouter`, `CoferFactory` and `UniV3SwapAdapter`, lists USDG with its feed, queues the adapter, and starts the ownership hand-off to the Safe.

```bash
cd contracts
read -rs DEPLOYER_KEY && export DEPLOYER_KEY
export RHC_RPC=https://...                       # your mainnet RPC
export MULTISIG=0x5ACD09eAe4f160e2f2e2356e6eF0496EF6f0f064
export GUARDIAN=0x...                            # the single guardian wallet
export SINK_WORK=$GUARDIAN SINK_TREASURY=$GUARDIAN SINK_PERKS=$GUARDIAN SINK_BURN=$GUARDIAN
forge script script/Deploy.s.sol --rpc-url robinhood --broadcast
unset DEPLOYER_KEY
```

### 4. Hand-off, from the Safe

1. Call `acceptOwnership()` on **both** `CoferFactory` and `FeeRouter`. Until then the deployer key is still the owner.
2. At least 48h after the deploy, call `applyAdapter(<adapter address>)` on `CoferFactory`.
3. List stocks: `cd services && bun run assets TSLA NVDA SPY AAPL` prints the `listAsset` calls (canonical addresses from the issuer, feeds and pool depth checked). Submit them as one Safe batch.

### 5. Check what is live (read-only)

```bash
cast call <factory> "owner()(address)" --rpc-url $RHC_RPC          # the Safe
cast call <factory> "pendingOwner()(address)" --rpc-url $RHC_RPC   # 0x000...000 after hand-off
cast call <factory> "guardian()(address)" --rpc-url $RHC_RPC
cast call <factory> "isAdapter(address)(bool)" <adapter> --rpc-url $RHC_RPC
cast call <factory> "swapFeeBps()(uint16)" --rpc-url $RHC_RPC
cast call <feeRouter> "owner()(address)" --rpc-url $RHC_RPC        # the Safe
```

### 6. Services

```bash
cd services
cp .env.example .env            # fill it in with a text editor; never commit it
bun install --frozen-lockfile
bunx drizzle-kit migrate
```

In `.env`: `CHAIN_ID`, `RHC_RPC_URL`, `FACTORY_ADDRESS`, `ADAPTER_ADDRESS`, `START_BLOCK` (the deploy block), `PUBLIC_URL` (HTTPS), the Telegram, ZeroDev and relayer settings, a random `LINK_SECRET` (`openssl rand -hex 32`), `OPS_CHAT_ID` for alerts, and `CARD_ADAPTER=off`. Fund the relayer address with a little ETH; the keeper alerts below `RELAYER_MIN_ETH`.

Run each role as its own process (the `api` role sets the Telegram webhook itself):

```bash
bun run api
bun run indexer
bun run keeper
bun run notifier
```
