# Dashboard

The dashboard shows a member their own group accounts: value, holdings with live prices, members,
proposals and their status, recent activity and the exit window (phase 1). Its action buttons hand
off to the existing signer page (phase 2a, below). The dashboard itself never signs, votes, moves
money or creates a proposal: signing happens only on the signer page, as before, and proposals are
still made in the group chat. The plan for creating proposals from the dashboard (phase 2b, not
built) is in [dashboard-phase-2b.md](dashboard-phase-2b.md).

| | Testnet | Mainnet |
| --- | --- | --- |
| Address | https://testdashboard.getcofer.com | https://dashboard.getcofer.com |
| Backend (services `api` role) | port 8443 | port 8444 |
| `DASHBOARD_URL` in the services `.env` | `https://testdashboard.getcofer.com` | `https://dashboard.getcofer.com` |
| `config.json` beside the files | from `site/dashboard/config.testnet.json` | from `site/dashboard/config.mainnet.json` |

One build serves both. The built files (`site/dashboard-dist/`) contain no chain id, chain name,
explorer, token or contract address, bot username or API address. They come from `config.json` on
each server and from the services `.env`. Going to mainnet needs no rebuild.

The signer page is reached on its own address (`PUBLIC_URL`, unchanged); the dashboard's Caddy block
does not forward any signer path.

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
| `GET /api/dashboard/pots/<address>` | one pot's view, with each action button's state; 404 if it does not exist **or** the member is not in it (the same answer) |
| `POST /api/dashboard/links` `{ "pot", "action" }` or `{ "pot", "action": "approve", "proposal" }` | `{ url, expiresAt }`: a one-time signer-page link for the session's own member (phase 2a) |

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

## Action buttons (phase 2a)

| Button | Opens the signer page for | Disabled when (the reason shown) |
| --- | --- | --- |
| Deposit | `deposit` for this pot | the group closed deposits; a held stock's price is older than the pot's 12-hour limit (markets closed); the beta limit is reached |
| Spend allowance | `sign` `spend:<pot>` | no allowance in this group; allowance used up for this period |
| Claim set-aside token | `claim` for this pot | nothing is set aside for this member |
| Exit with my share | `exit` for this pot | never: exiting is never gated |
| Approve / review (on a pending proposal) | `sign` for that proposal | already executed, expired, cancelled by a group change, failed, already approved and waiting for the exit window, or the member already approved it |

Everything else (send, buy, sell, allowance, join, plan, region) shows a hint such as "Use /send in
the group": the bot builds and checks those proposals there.

How a button works: the page asks `POST /api/dashboard/links` with only the pot, the action and (to
approve) the proposal. The server checks the dashboard session, finds the member from the session's
own Telegram account (a request naming a member or any other field is refused with 400), checks they
are an active member of that pot (404 otherwise, the same as a missing pot) and that the proposal
belongs to that pot, and runs the same availability rules again (409 with the reason if the action
cannot work now). It then makes exactly the link the bot makes for `/deposit`, `/spend`, `/claim`,
`/exit` or a vote card: same purpose and reference, valid 15 minutes, usable once, made for the
member's private chat. The page opens a new tab at once on the click (so the browser allows it),
cuts it off from the dashboard, and sends it to the link; if the server refuses, the tab closes and
the reason is shown. Only a signer-page address (`https://<signer>/s/<token>`) is ever opened. If the
browser blocks the tab, the page shows the link to tap. Each click makes a new link; two at once make
two separate links, each usable once. The signer page then works exactly as from the bot, and the
dashboard shows submitted, pending, confirmed or failed from the indexer on its next read (15
seconds after a button, then every 20 seconds).

The signer page checks everything again (deposit price age, beta limit, allowance, vote validity),
and the contracts refuse anything the rules do not allow; the disabled buttons only save the member
a wasted trip. A check that could not be read leaves the button on, as the bot does.

Phase 2a code: `services/src/dashboard/actions.ts` (the rules and reasons), `routes.ts` (`POST
/links`), `data.ts` (live deposit checks, set-aside amounts), `site/src/lib/dash-open.ts` (opening
the tab), the buttons in `site/src/cofer-store.tsx`. Tests: `services/test/dashboardActions.test.ts`,
`site/test/dashboard.test.ts`.

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
9. Action buttons (testnet only, with test funds): tap **Deposit**; a new tab opens the signer page
   (on the `PUBLIC_URL` address) for that pot; make a small deposit there. Within a minute the
   dashboard shows it in the activity and the value. Then: **Approve / review** on a pending proposal
   (make one with `/send` in the group first) opens that vote; after signing, the proposal shows
   "you approved" and its button is disabled with "You already approved this proposal". **Exit**
   opens the exit page (close the tab without signing unless you mean to exit). Check a disabled
   button and its reason, for example **Claim** with nothing set aside. Open the same signer tab's
   address again in another tab: the signer page says the link was used.

## Updating a running dashboard (for example phase 2a)

No new setting, no Caddy change, no database migration. On the testnet server, one step at a time:

1. `cd <repo> && git pull`
2. Restart the testnet services (for example `sudo systemctl restart cofer-testnet`).
3. `sudo rsync -a --delete <repo>/site/dashboard-dist/ /var/www/testdashboard.getcofer.com/ --exclude config.json`
   (the server's own `config.json` stays).
4. Run the checks in steps 7 to 9 above. Then the same three steps on mainnet with `cofer-mainnet`
   and `/var/www/dashboard.getcofer.com/`.

## Mainnet (no rebuild)

The same steps with the mainnet values: DNS for `dashboard.getcofer.com`; `git pull`;
`DASHBOARD_URL=https://dashboard.getcofer.com` in the mainnet services `.env` and restart
`cofer-mainnet`; copy the same `site/dashboard-dist/` to `/var/www/dashboard.getcofer.com/`; copy
`site/dashboard/config.mainnet.json` there as `config.json`; add the `dashboard.getcofer.com` Caddy
block (port 8444) and reload Caddy; run the same read-only checks.

To turn the dashboard off: remove `DASHBOARD_URL` and restart the services (the button and the API
routes disappear), then remove the Caddy block.
