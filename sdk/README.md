# Cofer SDK

Read-only helpers for Cofer on Robinhood Chain. It lives in this repo and is not published to npm.

```bash
cd sdk && bun install && bun test
```

## predictPotAddress

A group's account address, worked out offline, before the account exists. Same maths as the factory contract's
`predictPot`.

```ts
import { predictPotAddress } from "./sdk/src";

predictPotAddress({ chatId: -1001234567890, creator: "0x1111111111111111111111111111111111111111", factory: 4663 });
// "0x650451dEE919161f7378D2937dC1fa5089f75097"
```

| Input | Meaning |
|---|---|
| `chatId` | the Telegram group's chat id. It is used only in this calculation, on your computer. |
| `creator` | the key that runs (or ran) `/newpot` for the group |
| `factory` | `4663` (mainnet), `46630` (testnet), or a factory address |
| `implementation` | only for a factory the SDK does not know: its `implementation()` |

How it works:

1. `salt = keccak256("cofer:" + chatId)`, as the bot does.
2. `cloneSalt = keccak256(abi.encode(creator, salt))`, as `CoferFactory.predictPot` does.
3. The address is the CREATE2 address of a minimal clone (EIP-1167) of `implementation`, made by `factory` with
   `cloneSalt`.

Check it against the chain yourself:

```bash
cast call 0x5d03d53A5630ceCC545Be46635779094A11E47D7 "predictPot(address,bytes32)(address)" \
  0x1111111111111111111111111111111111111111 $(cast keccak "cofer:-1001234567890") \
  --rpc-url https://rpc.mainnet.chain.robinhood.com
```

The tests compare the SDK with answers recorded from both live factories.
