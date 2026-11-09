# Cofer team bot: staff and server guide

The existing alert bot also runs the launch updates in the staff group: one update every hour, a
pinned launch board, and a few read-only commands. It is the same bot that posts the alerts
([alerts.md](alerts.md)); no new bot.

Pause, resume, hold and release are done on the server only, never from Telegram.

## What the staff group sees

**The pinned launch board.** One message, pinned once and edited in place:

```
COFER LAUNCH BOARD
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

**Each update, at its hour** (update N at launch + N − 1 hours):

1. Its checks run (below).
2. Its GitHub release `update-NN` is published, if it is still a draft.
3. Two copy-ready posts: the square poster with the Telegram text, then the wide poster with the X
   text and its character count. Copy them to the channel and to X.

Update 1 is preceded by **🟢 COFER IS LAUNCHED**, and the last one is followed by **🏁 ALL 55 UPDATES ARE LIVE**.

**The checks.** An update goes out only when all of these hold:

- its status is VERIFIED, or it was marked checked on the server (`cofer-release verify N`)
- both poster files are in the data folder
- its changelog line is in `CHANGELOG.md` on main (only for updates whose changelog is "add")
- its GitHub release `update-NN` exists (a draft is fine: it is published at that hour)

If anything is missing, the update is **held**: nothing about it is posted, the group is told why
in plain words, and the next update still goes out on time.

## Messages

Each one is posted once per real change.

| Message | What it means | Who acts |
|---|---|---|
| 🟡 HELD · Update NN | It failed its checks (reasons listed) or was held on the server. Nothing was posted. | Fix the reasons, then on the server: `cofer-release release NN`. |
| 🔴 FAILED · Update NN | GitHub or Telegram refused while it was going out. | Dev checks, then `cofer-release release NN`. Posts that already went out are not sent again. |
| ⏸ PAUSED · updates | Paused from the server. One update already posting finishes. | Nothing. |
| ▶️ RESUMED · updates | The pause ended. Only ever follows a PAUSED. Overdue updates go out first, 2 minutes apart. | Nothing. |
| 🟢 SCHEDULE ARMED / LAUNCH TIME CHANGED | The launch time was set, followed by the full list day by day. | Check the times. |
| ⏸ SCHEDULE CANCELLED · launch | The launch time was cleared before launch. | Nothing. |
| 🟢 COFER IS LAUNCHED | Update 1 is live. | Nothing. |
| 🏁 ALL 55 UPDATES ARE LIVE | The last update went out. | Nothing. |
| 🟡 PREFLIGHT · N of 55 ready / 🟢 PREFLIGHT ALL CLEAR | The result of a check run from the server. | Fix anything listed before its hour. |

Every incident message says what happened, whether users are affected (normally "No. Cofer keeps
running."), what was done, and what comes next.

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

## Server commands

On the server only, through the `cofer-release` shortcut (set-up below):

| Command | What it does |
|---|---|
| `cofer-release preflight` | checks every update now and prints what is missing |
| `cofer-release preflight --post` | the same, and reports it to the staff group |
| `cofer-release test 14` | sends update 14's two posts to the test group only (never the staff group) |
| `cofer-release arm "2026-11-30 18:00"` | sets the launch time, in UTC. It can change until the first update is out |
| `cofer-release disarm` | clears the launch time before launch |
| `cofer-release pause "reason"` | stops new updates |
| `cofer-release resume` | continues; overdue updates go 2 minutes apart |
| `cofer-release hold 15 "reason"` | keeps one update back |
| `cofer-release release 15` | lets a held update go; its checks run again first |
| `cofer-release verify 23` | marks a RECHECK update as checked |
| `cofer-release status` | prints the board and the reason for anything held |

arm, disarm, pause, resume, hold, release and verify are handed to the running bot, and its answer
is printed. "The bot did not answer" means the mainnet keeper is not running, or the team bot is not
switched on there.

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
| `TEAMBOT_GITHUB_TOKEN` | secret. A fine-grained token for this repo only, "Contents: read and write", so draft releases can be seen and published |
| `TEAMBOT_GITHUB_MODE` | `publish` (default), `check` (only check that the release exists) or `off` |
| `TEAMBOT_TEST_CHAT_ID` | optional; a separate test group for `cofer-release test` |

It also needs `ALERT_BOT_TOKEN` and `OPS_CHAT_ID`, which are already set for the alerts. If a
setting is wrong, the team bot does not start, the keeper log says why (`[teambot] not started: ...`)
and the alerts carry on as normal.

### The alert bot in the staff group

- Make it an admin of the staff group with **Pin messages**, so it can pin the board.
- It reads the group with long polling, so it must not have a webhook set.

### The data folder

The folder is private, on the server, and outside the repo. The repo is public: **never commit these files**.

| File | What it is |
|---|---|
| `updates.json` | the 55 updates (number, type, title, status, changelog, Telegram text, X text) |
| `config.json` | repo, explorer, contracts, links, demo videos (message numbers in the staff group), health checks, roadmap image |
| `posters/square/update-NN-square.png` | square poster, for Telegram |
| `posters/wide/update-NN-wide.png` | wide poster, for X |
| roadmap image | the file `config.json` names, inside this folder |
| `state.json`, `inbox/` | written by the bot: what has gone out. Do not edit while it runs |

Make the folder readable only by the user that runs the services. Back up `state.json` before you
move the folder. If `state.json` is damaged, the bot refuses to start rather than starting over,
because starting over could post updates twice.

### The `cofer-release` shortcut

A three-line file on the server (for example `/usr/local/bin/cofer-release`, made executable).
Replace the parts in angle brackets with your own:

```sh
#!/bin/sh
cd <path to the repo>/services || exit 1
exec sudo -u <user that runs the services> <path to bun> scripts/teambot.ts "$@"
```

The script reads the same settings as the services. If they come from a systemd environment file
rather than `services/.env`, load that file in the shortcut first. On any server where the team bot may
not run, the script only prints why and does nothing.

### Before launch

1. Create every GitHub release `update-01` ... `update-55` as a draft.
2. `cofer-release preflight --post`, then fix whatever it lists.
3. `cofer-release test 1` and check both posts in the test group.
4. `cofer-release arm "YYYY-MM-DD HH:MM"` (UTC), then check the schedule it posts.
5. Check that the board is pinned in the staff group.

Logs: the keeper's log, lines starting `[teambot]`.
