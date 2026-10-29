# Cofer (working name)

A shared group money account on Robinhood Chain (4663), run from a Telegram group chat.

- `contracts/`: Solidity 0.8.28, dependency-free (minimal libs vendored). `CoferPot` (one EIP-1167 clone per group), `CoferFactory` (registry + timelocked admin), `UniV3SwapAdapter`, `FeeRouter`, mocks, forge-style tests, `script/Deploy.s.sol`.
- `services/`: Bun + Hono + tRPC v11 + Drizzle (Postgres) + BullMQ + viem + grammY. Plain Telegram bot, signer site + API, relayer, indexer, keeper, notifier, card adapter interface + stub.
- `tools/banned-words.ts`: CI gate for banned marketing words.

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
3. **The studio cannot move funds.** Admin powers are limited to pausing new deposits and new pots, and to listing or delisting buyable assets. Feed, adapter and fee changes are timelocked for 48h.
4. **Feeds already include the Stock Token multiplier.** Value = raw balance x feed answer, and the multiplier is never applied a second time.
5. **Plain bot.** The bot has no Mini App and no `web_app` buttons (enforced by test). Signing happens on an external site opened with `url` buttons.
