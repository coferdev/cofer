# Cofer team bot: staff and server guide

The existing alert bot also posts the launch updates in the staff group: one update every hour, a
pinned launch board, and a few read-only commands. It is the same bot that posts the alerts
([alerts.md](alerts.md)); no new bot.

The team bot and the release system work as one system:

- The **release system** (a private job on the server) does the work for each update: its checks,
  the build and tests, the deploy to testnet and then mainnet with live checks (rolled back if one
  fails), the public commit and the GitHub release `update-NN`. It never posts in Telegram.
- When an update is live and released, at its posting minute, the release system tells the team bot,
  and **only the team bot posts**. Held, delayed and rolled-back updates are reported the same way.
- The team bot has no clock of its own for updates: nothing is posted unless the release system
  reports it, so nothing is posted twice and nothing is posted before it is live.

Pause, resume, hold and release are done on the server only, never from Telegram.

## What the staff group sees

**The pinned launch board.** One message, pinned once and edited in place:

```
COFER LAUNCH
Live    14 / 55   ▰▰▰▱▱▱▱▱▱▱▱▱
Next    Update 15 · How it works
        08:00 · 11:00 · 3:00 AM
        Tue 1 Dec · in 42 min
Queue   ● running
Held    none
Last: Update 14 · <title>
github.com/<owner>/<repo>/releases/tag/update-14
```

Times are always UTC · Moscow · New York.

**Each update, at its minute** (update N at launch + N − 1 hours), once the release system reports it
live and released:

1. A heading in bold: **Tech Updates: Update NN Released**.
2. The square poster with the Telegram text.
3. A zip holding only that square poster (Telegram makes photos smaller; the zip keeps it exact).
4. The wide poster with the X text and its character count.
5. A zip holding only that wide poster.
6. The status line: **✅ SHIPPED AND RELEASED · Update NN · release update-NN**, the title, what
   happened, what is next and the release link.

Copy the posts to the channel and to X. Update 1 is preceded by **🟢 COFER IS LAUNCHED**, and the last
one is followed by **🏁 ALL 55 UPDATES ARE LIVE**.

**30 minutes after each release**, a board poster: a picture of the board with the board as its
caption (drawn ahead of time; whenever an update is held, the board is posted as text instead). If two
releases are close together, only the latest one is posted.

**Every day at 23:55 UTC** on a day with releases, **Shipped today**: each update released that UTC day
with its release link, and the time in UTC, Moscow and New York.

## Status lines

Each is posted once. The first line is always `<status> · Update NN · release update-NN`.

| Line | What it means | Who acts |
|---|---|---|
| ✅ SHIPPED AND RELEASED | Live on testnet and mainnet, its live checks pass, public commit and GitHub release out. Follows the full set. | Nothing. |
| 🟡 RELEASE DELAYED | Live and its checks pass, but the public push or the GitHub release did not go through by its minute. Retried every 2 minutes; the full set and ✅ follow. | Dev checks the emergency in Alert Test. |
| 🟡 HELD | It was not ready at its minute (a check, the build or the tests failed), or it was held on the server. Nothing deployed. The next update keeps its own time. | Fix it, then on the server: `cofer-release release NN`. |
| 🔴 ROLLED BACK | It was deployed, a live check failed, and the previous version is back on every target. | Fix it, then `cofer-release release NN`. |

Other messages: ⏸ PAUSED · updates, ▶️ RESUMED · updates (overdue updates then go 2 minutes apart),
🟢 SCHEDULE ARMED / LAUNCH TIME CHANGED (with the full list day by day), ⏸ SCHEDULE CANCELLED · launch,
🟡 PREFLIGHT · N of 55 ready / 🟢 PREFLIGHT ALL CLEAR.

## Release emergencies (Alert Test only)

Every problem while an update is being prepared is a 🔴 emergency in **Alert Test**
(`TEAMBOT_TEST_CHAT_ID`), never in the staff group. The work for each update starts 30 minutes before
its minute, so there is time to fix it.

```
🔴 ALERT · release-tests-failed-07

What happened: The tests failed while building Update 07.
Update: 07, posting at 14:00 UTC · 17:00 Moscow · 9:00 AM New York
Who acts: Dev fixes it, then on the server: cofer-release release 7.
Still open after 4m. /ack pauses this alarm for 15 minutes.
```

- Each alarm's name ends with its update's number, so two updates failing the same way never share one.
- It is repeated **every 2 minutes** until it is fixed.
- **/ack** in Alert Test (as a reply to the alarm, or `/ack <name>`, or `/ack` alone when only one is
  open) pauses that one alarm for **15 minutes**. Still open after that, it repeats again.
- When it is fixed: one `🟢 CLEARED · <name> (<reason>)`.
- The team bot also watches the release system: if it stops (`release-system-stopped`), that is an
  emergency too. The release system watches the team bot the same way.

In a dry run, every staff post starts with `🧪 DRY RUN · STAFF POST` and every emergency with
`🧪 DRY RUN · EMERGENCY`; a `cofer-release test N` post starts with `🧪 TEST · STAFF POST`.

## Commands in the staff group

They work in the staff group only. The bot ignores normal chat, commands meant for other bots and messages from bots.

| Command | Answer |
|---|---|
| `/status` | the launch board |
| `/next` | the next 3 updates and when |
| `/schedule 1` | the list for day 1 (also 2, 3) |
| `/poster 14` | both posters of an update that is already out |
| `/changelog` | the latest releases |
| `/roadmap` | the roadmap |
| `/contracts` | every contract, with explorer links |
| `/socials` | our links |
| `/videos`, then `/video 3` | the demo videos |
| `/health` | whether the sites answer |
| `/help` | this list |

## Replying to the bot

Reply to any message the bot sent in the staff group, and it answers with one line:

```
I answer commands only: /status, /next, /schedule, /poster N, /changelog, /roadmap, /contracts, /socials, /videos, /health, /help.
```

It answers each message at most once every 30 seconds, however many people reply to it. Replies from
bots and replies in other chats are ignored. A command sent as a reply (for example `/next`) runs as
that command.

## Server commands

On the server only, through the `cofer-release` shortcut, which runs the **release system's** commands:
`arm "YYYY-MM-DD HH:MM"` (UTC), `disarm`, `pause "reason"`, `resume`, `hold N "reason"`, `release N`,
`verify N`, `status`, `preflight [--post]`, `test N` (the full set of update N to Alert Test only).
The release system tells the team bot what to post. The team bot's own command is read-only:
`cd services && bun scripts/teambot.ts status`.

## For the dev: set-up

### Where it runs

On the **mainnet** service only, inside the keeper (`ROLE=keeper` or `ROLE=all`). Run one mainnet
keeper only: two processes reading the same bot would be refused by Telegram. The testnet service
never posts updates or reads the alert bot: leave `TEAMBOT_ENABLED` unset there. Even if it is set
there by mistake, the team bot refuses to start on any chain but 4663.

### Settings (services `.env` on the mainnet server)

| Setting | Value |
|---|---|
| `TEAMBOT_ENABLED` | `1` |
| `TEAMBOT_DATA_DIR` | full path of the private data folder (below), outside the repo |
| `TEAMBOT_TEST_CHAT_ID` | Alert Test: release emergencies, `/ack` and test posts. Never the staff group |
| `TEAMBOT_RELEASE_HEARTBEAT` | optional; full path of the release system's heartbeat file, so the team bot can tell when it stops |

It also needs `ALERT_BOT_TOKEN` and `OPS_CHAT_ID`, which are already set for the alerts. The team bot
holds no GitHub token: the release system makes the releases. Old `TEAMBOT_GITHUB_*` settings are
ignored. If a setting is wrong, the team bot does not start, the keeper log says why
(`[teambot] not started: ...`) and the alerts carry on as normal.

### The alert bot in the staff group and Alert Test

- Make it an admin of the staff group with **Pin messages**, so it can pin the board.
- It must be a member of Alert Test, to post emergencies there and read `/ack`.
- It reads the groups with long polling, so it must not have a webhook set.

### The data folder

The folder is private, on the server, and outside the repo. The repo is public: **never commit these files**.

| File | What it is |
|---|---|
| `updates.json` | the 55 updates (number, type, title, status, changelog, Telegram text, X text) |
| `config.json` | repo, explorer, contracts, links, demo videos (message numbers in the staff group), health checks, roadmap image |
| `posters/square/update-NN-square.png` | square poster, for Telegram |
| `posters/wide/update-NN-wide.png` | wide poster, for X |
| `posters/board/board-NN.png` | the board poster for "NN of 55 live" |
| roadmap image | the file `config.json` names, inside this folder |
| `state.json`, `inbox/`, `zips/`, `heartbeat` | written by the bot and the release system. Do not edit while it runs |

Make the folder readable only by the user that runs the services. Back up `state.json` before you
move the folder. If `state.json` is damaged, the bot refuses to start rather than starting over,
because starting over could post updates twice.

Logs: the keeper's log, lines starting `[teambot]`.
