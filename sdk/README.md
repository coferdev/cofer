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

## buildExit

Everything a member's exit needs: the exact call, what it pays now, the destination checks the signer page uses, and
the steps to check it on a block explorer.

```ts
import { buildExit } from "./sdk/src";
import { createPublicClient, http } from "viem";

const client = createPublicClient({ transport: http("https://rpc.mainnet.chain.robinhood.com") });
const kit = await buildExit({ pot: "0x…", shares: "1000000000000000000", to: "0x…your key…" }, client);
// kit.refused  null, or the reason (for example "That is the zero address. Anything sent there is lost.")
// kit.call     { to: <group account>, data: "0xcff40759…", function: "exit(uint256,address)", args }
// kit.preview  [{ asset, amount }] raw amounts per token, from the pot's previewExit
// kit.steps    the explorer steps
```

- The call is sent by the member's own key account to the group account. Exits use no price and no vote, and
  nothing can pause them.
- Pass `blocked` (factory, fee router, adapters, USDG, listed Stock Tokens, other group accounts) to refuse every
  contract address the signer page refuses; the reasons are word for word the same.
- Without a reader it works offline and `preview` is `null`.
- The tests run the call inside the real group account code, and compare every refusal with the signer page's.

## verifyReceipt

Checks any receipt from `/v1/receipts/exit|deposit|spend/:tx` or `/v1/receipts/vote/:digest` against the chain,
through an RPC you choose, and names every line that does not match.

```ts
import { verifyReceipt, verdictText } from "./sdk/src";
const receipt = await (await fetch("https://<signer site>/v1/receipts/exit/0x…")).json();
console.log(verdictText(await verifyReceipt(receipt, "https://rpc.mainnet.chain.robinhood.com")));
// Receipt matches the chain (8 lines checked).
```

From the command line (read-only, never signs):

```bash
bun sdk/bin/cofer.ts verify receipt.json --rpc https://rpc.mainnet.chain.robinhood.com
```

- exit, deposit, spend: the transaction's logs from the group account are read again and every figure compared.
- vote: the digest is made again from the signed message and asked of the group account (`hashProposal`), and each
  approval not withdrawn is verified again (ERC-1271 for keys that are accounts).

## createCoferClient

Typed, read-only access to every public API call, plus two direct chain reads for when you would rather not trust
the API.

```ts
import { createCoferClient } from "./sdk/src";

const cofer = createCoferClient({ baseUrl: "https://<signer site>" });
const pot = await cofer.pot("0x…");                 // PotSummary
const votes = await cofer.votes("0x…", { state: "queued" });
const receipt = await cofer.exitReceipt("0x…");

const direct = await cofer.potFromChain("0x…");      // the same summary, read from the chain itself
const members = await cofer.membersFromChain("0x…");
```

Methods: `status`, `tx`, `ownership`, `pot`, `members`, `votes`, `timeline`, `exitReceipt`, `depositReceipt`,
`spendReceipt`, `voteReceipt`, `keyGroups`, `setAsides`, `adminPending`, `holdings`, `snapshotProof`, `fees`. An error
answer throws `CoferApiError` with the API's own status, code and message. Big numbers stay decimal strings. A test
runs every method against the real API server and checks each answer's fields against the types.

## The cofer command line

Read-only: it holds no key and can never sign or send.

```bash
bun sdk/bin/cofer.ts pot <group address> --api https://<signer site>
bun sdk/bin/cofer.ts member <address> --api https://<signer site>
bun sdk/bin/cofer.ts exit-check <group address> <member address>       # reads the chain directly
bun sdk/bin/cofer.ts tx <hash> --api https://<signer site>
bun sdk/bin/cofer.ts verify receipt.json                                # reads the chain directly
```

`--api` can also be set once with `COFER_API`. `--rpc <url>` picks the chain RPC (default: mainnet's public RPC).
`exit-check` shows a member's shares, what a full exit would pay right now, and the exact call their key account
sends.
