# Threat model

What Cofer protects, against whom, and what it does not protect. Roles and functions are listed in
[architecture.md](architecture.md); open issues are tracked in [SECURITY.md](../SECURITY.md).

## What is protected

1. **Each member's share of the pot**: it can be taken out at any time, in kind, without anyone's permission.
2. **The group's decisions**: funds move only with enough members' own signatures over the exact action.
3. **Members' keys and accounts**: a Telegram tap never authorises a money action on its own.

## Who might attack, and what stops them

| Attacker | Can | Cannot, because |
| --- | --- | --- |
| An outsider | Call `execute` with valid signatures someone else made; call `claimOwed` (it always pays the owed account); send tokens to a pot. | Move funds: every move needs members' signatures (`CoferPot._countVotes`). Deposit: members only. |
| A single member | Deposit, exit, spend their own allowance, propose and sign votes, revoke their vote. | Take more than their share (`_exit` pays pro rata); spend beyond their allowance; pass a vote alone unless the threshold is one. |
| A colluding majority | Pass votes, including transfers to themselves and swaps through pools they control (each swap bounded by the oracle floor). | Run any of them before dissenters can exit: every non-unanimous vote, swaps included, waits `guardDelay`, and the group is told even if the vote was made outside the bot. |
| The studio (owner Safe) | Pause new deposits and new pots; list or delist buyable assets; after 48h, change feeds, adapters and the swap fee; change the plan price immediately (a plan vote still never pays more than the `maxCost` members signed); redirect fees. | Move, freeze or gate a pot's funds; block or pause an exit; vote. |
| The guardian key, if leaked | Pause or unpause new deposits and new pots; take fees already sent to the sink wallet. | Touch any pot's funds or exits. The Safe can replace the guardian. |
| A compromised server or database | Show misleading text in Telegram; send wrong proposal data to the signer page; refuse service. | Get a passkey to sign different bytes: the page rebuilds and checks every vote, confirms the pot on-chain, and signs only what it built (`services/src/core/signCheck.ts`). Move funds with sessions or links alone. |
| A leaked `LINK_SECRET` | Make links and sessions for any Telegram user, including binding the attacker's own key to a Telegram account that has no key yet (that person's later `/join` would then propose the attacker's address). Rotate the secret at once if it leaks. | Sign or send anything with an existing member's key: every money action needs the member's own key. Bind a new key to an account that already has one. |
| A price feed that is wrong | Make deposits mis-priced and set a wrong swap floor. | Affect exits, which use no oracle. Feed changes need 48h. Price a deposit on a stock price more than 12 hours old (`MAX_DEPOSIT_PRICE_AGE`). |
| A token issuer | Pause its token. | Block the other assets in an exit: a refused transfer is set aside for `claimOwed`. |

## What this does not protect

- **After-hours moves within the 12-hour deposit limit.** A big move after the US close (for example on earnings) can make a deposit's oracle price differ from the market by more than the 0.5% entry spread for up to 12 hours; a member who deposits then and exits in kind takes the difference from the others. Accepted in SECURITY.md with the feed data behind the 12-hour choice.
- **The audit's contract fixes are not live yet.** H-2, M-1 and L-1 are fixed in `contracts/src` but wait for the owner's re-audit and a new deploy.
- **Members who do not act in the exit window.** The window protects members who read the group's notices and exit in time; a colluding majority can still take, after the wait, from members who stay.
- **A replaced signer-page script.** The page's checks run inside the page; whoever can change the script the site serves can skip them. Members who want independent checks can use their own browser wallet.
- **Members' own devices and passkeys.** Anyone who controls a member's phone or passkey can act as that member.
- **Telegram itself.** If Telegram or a member's Telegram account is taken over, the attacker can read the group and tap buttons, but still needs the member's key to move funds.
- **Token issuers and Chainlink.** A paused token stays paused for everyone; a feed outage pauses deposits and swaps until it recovers.
- **In-kind exits.** Exiting members receive assets as they are; nothing is converted for them, and a stock token's market value is not guaranteed.
- **Card providers.** Cards are off; a future provider would be trusted with what it is sent.
