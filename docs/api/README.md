# Cofer public API

Read-only facts about Cofer, straight from Robinhood Chain. No sign-in and no keys.

- **Address:** the signer site's address plus `/v1`, for example `https://<signer site>/v1/status`.
- **Read-only:** only `GET` (and `OPTIONS` for browsers). Nothing here can move money or change anything.
- **On-chain data only:** addresses, amounts, blocks and times that anyone can read from the chain. Never a
  Telegram name, username, id or chat id.
- **Limits:** 60 requests a minute per client address, and a cap for all clients together. Over it, the answer is
  `429` with a `Retry-After` header (seconds).
- **CORS:** open for `GET`, so any page or tool can call it.
- **Caching:** each route says how long its answer may be cached (`Cache-Control`, and `meta.cacheSeconds`).
  Answers are read once per cache period for everyone, so a busy API never slows the bot.

## Answer format

```json
{
  "data": { "...": "..." },
  "meta": { "chainId": 4663, "generatedAt": "2026-12-01T14:00:05.000Z", "cacheSeconds": 15 }
}
```

- Token amounts and block numbers are decimal strings (`"1000020"`), so nothing is rounded.
- Token amounts are raw units; each answer gives the token's `decimals` where it shows an amount.
- Errors: `{ "error": { "code": "not_found", "message": "..." } }` with the matching HTTP status
  (`400`, `404`, `405`, `429`, or `503` when the chain or database cannot be read just then).

## Routes

| Route | What it gives |
|---|---|
| [`GET /v1/status`](status.md) | chain, latest block, indexer lag, relayer gas (yes or no), age of every price feed |
