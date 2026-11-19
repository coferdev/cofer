# GET /v1/badge.svg

A small status image you can put in any README or page. It shows which chain Cofer reads and whether its indexer
is keeping up, from the same data as [`/v1/status`](status.md).

| Right side | Meaning |
|---|---|
| `indexer live` | the indexer is within its limit (5 minutes of chain time) |
| `indexer behind` | it is further behind; balances and votes shown by the bot may be out of date for a while. Exits are not affected. |
| `indexer not started` | it has not saved a block yet |
| `indexer unknown` | the chain could not be read just then |

## Embed it

Markdown (a README):

```markdown
![Cofer status](https://<signer site>/v1/badge.svg)
```

HTML (a page):

```html
<img src="https://<signer site>/v1/badge.svg" alt="Cofer status" height="20">
```

The image is plain SVG with no script and no outside reference. It may be cached for 15 seconds.
