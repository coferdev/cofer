# Integration guide

Everything for building on Cofer in one place: the status badge, the group feeds, the SDK, the command line tool, the
MCP server and the receipts. All of it is read-only: none of it can sign, send or change anything. Replace
`https://<signer site>` with Cofer's signer address and `0x…` with a group account (or transaction) of your choice.

## The status badge

```markdown
![Cofer status](https://<signer site>/v1/badge.svg)
```

It shows which chain Cofer reads and whether its indexer is live. Details: [badge](../api/badge.md).

## Feeds

Every release, in any feed reader:

```bash
curl https://<signer site>/v1/changelog.atom
```

One group's own feed of deposits, exits, votes and allowance spends:

```bash
curl https://<signer site>/v1/pots/0x362B6794E6374b400aA186C1a67AC2c060af2E50/feed.atom
```

Both also come as JSON Feed (`changelog.json`, `feed.json`).

## The public API

```bash
curl https://<signer site>/v1/status
curl https://<signer site>/v1/pots/0x362B6794E6374b400aA186C1a67AC2c060af2E50
curl https://<signer site>/v1/pots/0x362B6794E6374b400aA186C1a67AC2c060af2E50/votes?state=queued
```

Every route and field: [reference](../api/reference.md). For tools: `/v1/openapi.json`; in plain text: `/llms.txt`.

## The SDK (TypeScript, in this repo)

```ts
import { createCoferClient, verifyReceipt, predictPotAddress } from "./sdk/src";

const cofer = createCoferClient({ baseUrl: "https://<signer site>" });
const pot = await cofer.pot("0x362B6794E6374b400aA186C1a67AC2c060af2E50");
console.log(pot.memberCount, pot.voteRule.approvalsNeeded);

const direct = await cofer.potFromChain(pot.address); // the same summary, straight from the chain
```

More: [sdk/README.md](../../sdk/README.md) (exit kit, receipt checker, address prediction).

## The command line

```bash
bun sdk/bin/cofer.ts pot 0x362B6794E6374b400aA186C1a67AC2c060af2E50 --api https://<signer site>
bun sdk/bin/cofer.ts member 0x8251FA75f4982cDCB4bE015B9F7Ba20116a1596C --api https://<signer site>
bun sdk/bin/cofer.ts tx 0xcab71e51caab6f0081a3741e25261e2c89629f0ae867c4205943b4c11cac688f --api https://<signer site>
```

## The MCP server, for software agents

```bash
bun tools/mcp/server.ts --api https://<signer site>
```

Tools: `get_status`, `get_pot`, `get_members`, `get_votes`, `get_timeline`, `explain_tx`. More:
[tools/mcp/README.md](../../tools/mcp/README.md).

## Receipts

Get a receipt, then check it against the chain yourself:

```bash
curl https://<signer site>/v1/receipts/exit/0xaf53ab11fd839442ad4e55d975841c0ef4913764b29e09db697a1c72a742971d > receipt.json
bun sdk/bin/cofer.ts verify receipt.json --rpc https://rpc.testnet.chain.robinhood.com
```

Exit, deposit, allowance spend and vote receipts: [receipts](../api/receipts.md).
