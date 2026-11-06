# Dashboard (read-only, phase 1)

The dashboard shows a member their own group accounts: value, holdings with live prices, members,
proposals and their status, recent activity and the exit window. It cannot move money, sign, vote or
create anything. Proposals, approvals, deposits and exits stay in Telegram and on the signer page.

| | Testnet | Mainnet |
| --- | --- | --- |
| Address | https://testdashboard.getcofer.com | https://dashboard.getcofer.com |
| Backend (services `api` role) | port 8443 | port 8444 |
| `DASHBOARD_URL` in the services `.env` | `https://testdashboard.getcofer.com` | `https://dashboard.getcofer.com` |
| `config.json` beside the files | from `site/dashboard/config.testnet.json` | from `site/dashboard/config.mainnet.json` |

One build serves both. The built files (`site/dashboard-dist/`) contain no chain id, chain name,
explorer, token or contract address, bot username or API address. They come from `config.json` on
each server and from the services `.env`. Going to mainnet needs no rebuild.

getcofer.com is not part of this. Its files (`site/dist/`) are not rebuilt or changed by any step
here; never run `npm run build:ui` as part of a dashboard deploy (see `site/README.md`).

## How a member signs in

1. In Telegram the member sends `/me` (in the group, or in the private chat with the bot) or `/pot`
   in the group. The bot sends a private **Open dashboard** button: in a group as a message only that
   member sees, otherwise by private message. It is never put on the group's `/pot` reply, and it is
   only sent to a member with a key (for `/pot`, only to an active member of that pot). No new
   command; no Mini App, `web_app` or menu button.
2. The button opens `https://<dashboard>/#t=<one-time link>`. The link is in the part after `#`, so the
   browser never sends it to a server or a log. The page removes it from the address bar at once.
3. The page sends it once to `POST /api/dashboard/session`. The link is valid for 10 minutes, works
   once (two requests at the same moment: one wins), and must have been made for the member's own
   private chat. It is exchanged for a read-only session of 30 minutes, kept only in that browser tab.
4. When the session ends, the page says so and the member taps the button again.

A dashboard link or session is refused by the signer API, and a signer link or session is refused by
the dashboard. A dashboard session cannot create, sign or change anything.

## API (services, `api` role, only when `DASHBOARD_URL` is set)

| Route | Answer |
| --- | --- |
| `POST /api/dashboard/session` `{ "token": "<link>" }` | `{ session, expiresAt }`, or 401 |
| `GET /api/dashboard/pots` | `{ chainId, linked, address, pots: [...] }`: only pots where the member's own key is an active member |
| `GET /api/dashboard/pots/<address>` | one pot's view; 404 if it does not exist **or** the member is not in it (the same answer) |

All answers are JSON with `Cache-Control: no-store`. Every amount is a decimal string of raw token
units, sent with its token's decimals; the page formats it without ever turning it into a JavaScript
number. Prices are the factory's own `valueInUsdg` (the contract's rule), read live and kept for 15
seconds; a price the factory refuses (for example a stale feed while a market is closed) shows as
"price paused" and the total says it is partial. Balances, members, proposals and activity come from
the indexer (confirmed blocks only, `CONFIRMATIONS` behind the head). When the keeper's
`indexer-behind` alert is open, the page says the data may be a few minutes behind. A stored failure
reason is never sent; each proposal status has fixed text. If the database or the chain cannot be
read, the API answers 503 with fixed text (logged without URLs) and the page keeps the last data,
says so, and tries again after 5, 10, 20, 40 and then every 60 seconds. It reads every 20 seconds
while healthy and again when the tab comes back. The page checks that the API's `chainId` matches its
`config.json` and shows nothing if they differ.

Code: `services/src/dashboard/` (`routes.ts` sign-in and routes, `view.ts` the view, `data.ts` the
database and price reads), the bot button in `services/src/bot/bot.ts` (`/me`, `/pot`) and
`services/src/bot/keyboards.ts` (`dashboardUrl`). Site: `site/src/cofer-store.tsx`,
`site/src/dashboard.tsx`, `site/src/lib/` (`money.ts`, `dash-api.ts`, `dash-config.ts`,
`dash-session.ts`, `dash-text.ts`). Tests: `services/test/dashboard.test.ts`,
`services/test/dashboardBot.test.ts`, `site/test/dashboard.test.ts`.

## config.json

Placed next to `index.html` on each server; never in the repo's build folder (it is git-ignored
there and the build refuses to run if one is present).

```json
{
  "chainId": 4663,
  "chainName": "Robinhood Chain",
  "explorerUrl": "https://robinhoodchain.blockscout.com",
  "botUsername": "coferappbot",
  "siteUrl": "https://getcofer.com",
  "apiBase": "/api/dashboard"
}
```

`apiBase` must be a path on the dashboard's own address (the page refuses anything else), so the
browser never calls another origin and no CORS is needed. `config.testnet.json` ships with
`botUsername` left as `FILL IN`; the page refuses to start until it is the testnet bot's username.

## Build (once, for both networks)

Paste these lines one at a time:

```bash
cd site
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build:dashboard
```

The output is `site/dashboard-dist/` (five pages, one script, one stylesheet, the logo). Commit it
with the change, so a server only needs to pull and copy; it is the same files for testnet and mainnet.

## Caddy

One block per address. Each serves the static files and forwards only the dashboard API paths to its
own backend, so the page calls its API on its own address. No other backend path (`/trpc`, `/s/`,
`/tg/webhook`) is reachable through the dashboard address. Basic headers only, no custom CSP. Use the
same header lines as the other Cofer sites if they differ; change the folder paths to the server's.

```caddy
testdashboard.getcofer.com {
	encode zstd gzip
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options "nosniff"
		X-Frame-Options "DENY"
		Referrer-Policy "no-referrer"
		-Server
	}
	handle /api/dashboard/* {
		reverse_proxy 127.0.0.1:8443
	}
	handle {
		root * /var/www/testdashboard.getcofer.com
		@pages path / *.html /config.json
		header @pages Cache-Control "no-cache"
		@hashed path /assets/main-* /assets/style-*
		header @hashed Cache-Control "public, max-age=31536000, immutable"
		file_server
	}
}

dashboard.getcofer.com {
	encode zstd gzip
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options "nosniff"
		X-Frame-Options "DENY"
		Referrer-Policy "no-referrer"
		-Server
	}
	handle /api/dashboard/* {
		reverse_proxy 127.0.0.1:8444
	}
	handle {
		root * /var/www/dashboard.getcofer.com
		@pages path / *.html /config.json
		header @pages Cache-Control "no-cache"
		@hashed path /assets/main-* /assets/style-*
		header @hashed Cache-Control "public, max-age=31536000, immutable"
		file_server
	}
}
```

## Testnet deploy

On the server, one step at a time:

1. DNS: an A (or AAAA) record for `testdashboard.getcofer.com` pointing at the server.
2. Get the code: `cd <repo> && git pull`.
3. Services: in the testnet services `.env` (edit it with a text editor; never paste it anywhere), add
   `DASHBOARD_URL=https://testdashboard.getcofer.com`. No database migration is needed. Restart the
   testnet services (for example `sudo systemctl restart cofer-testnet`).
4. Files: `sudo mkdir -p /var/www/testdashboard.getcofer.com` then
   `sudo rsync -a --delete <repo>/site/dashboard-dist/ /var/www/testdashboard.getcofer.com/ --exclude config.json`.
5. Settings: `sudo cp <repo>/site/dashboard/config.testnet.json /var/www/testdashboard.getcofer.com/config.json`,
   then edit that copy and set `botUsername` to the testnet bot's username (without `@`).
6. Caddy: add the `testdashboard.getcofer.com` block above to the Caddyfile, then
   `sudo caddy validate --config /etc/caddy/Caddyfile` and `sudo systemctl reload caddy`.
7. Check (read-only): `curl -s https://testdashboard.getcofer.com/config.json` shows the testnet
   settings; `curl -s https://testdashboard.getcofer.com/api/dashboard/pots` answers
   `{"error":"Your dashboard session has ended. ..."}` (401: the API is reached and refuses without a
   session); `curl -s -o /dev/null -w "%{http_code}\n" https://testdashboard.getcofer.com/trpc/me.get` is 404 or
   another non-API answer from the static site, never the signer API.
8. In Telegram (testnet bot): `/me` in a group with a pot, tap **Open dashboard**, and check the
   value, holdings, members, proposals and activity against `/pot` and the explorer. Tap the same
   button again later: it says the link was used; send `/me` for a new one.

## Mainnet (no rebuild)

The same steps with the mainnet values: DNS for `dashboard.getcofer.com`; `git pull`;
`DASHBOARD_URL=https://dashboard.getcofer.com` in the mainnet services `.env` and restart
`cofer-mainnet`; copy the same `site/dashboard-dist/` to `/var/www/dashboard.getcofer.com/`; copy
`site/dashboard/config.mainnet.json` there as `config.json`; add the `dashboard.getcofer.com` Caddy
block (port 8444) and reload Caddy; run the same read-only checks.

To turn the dashboard off: remove `DASHBOARD_URL` and restart the services (the button and the API
routes disappear), then remove the Caddy block.
