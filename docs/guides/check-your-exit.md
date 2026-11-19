# Guide: check your own exit, step by step

Find your share of a group account, preview what an exit pays, and check the exit on the chain afterwards. Every
check here reads the chain directly: none of it needs the Cofer website or bot.

Two ways to follow it:

- **Explorer only:** a block explorer in your browser (mainnet:
  [robinhoodchain.blockscout.com](https://robinhoodchain.blockscout.com), testnet:
  [explorer.testnet.chain.robinhood.com](https://explorer.testnet.chain.robinhood.com)).
- **Command line:** [Foundry's `cast`](https://book.getfoundry.sh/cast/).

You need two addresses:

- **GROUP:** your group account's address (`/pot` in the bot shows it, and so does any vote or deposit on the explorer).
- **KEY:** your own key's address: your passkey account or your connected wallet account (`/me` in the bot shows it).

For `cast`, set them once (paste one line at a time; mainnet RPC shown, use
`https://rpc.testnet.chain.robinhood.com` for testnet):

```bash
export RPC=https://rpc.mainnet.chain.robinhood.com
export GROUP=0x...
export KEY=0x...
```

## 1. Find your share

Explorer: open GROUP, go to **Contract**, then **Read contract**, and run `memberInfo` with KEY.

```bash
cast call $GROUP "memberInfo(address)((bool,uint256,uint128,uint32,uint64,uint128))" $KEY --rpc-url $RPC
```

The answer is `(active, shares, allowance, period, periodStart, spent)`. `shares` is your share count (18 decimals).
For your share of the whole group, compare with:

```bash
cast call $GROUP "totalShares()(uint256)" --rpc-url $RPC
```

## 2. Preview what an exit pays

Explorer: **Read contract**, `previewExit`, with your share count from step 1 (or part of it).

```bash
cast call $GROUP "previewExit(uint256)(address[],uint256[])" <shares> --rpc-url $RPC
```

The answer is two lists in the same order: each token the group holds, and the raw amount of it your shares get.
USDG has 6 decimals. Exits use no price: you get your exact share of every token, in kind.

## 3. The exit itself

The exit is one call from your own key's account to the group account:

```bash
cast calldata "exit(uint256,address)" <shares> $KEY
```

That is exactly what the signer page sends when you tap Exit (to your own key, or to an address you type there).
Your key's account is a smart account, so the call is signed with your passkey or your connected wallet; Cofer
holds no key and cannot send, stop or change it. No vote, pause or price feed can block `exit()`.

## 4. Check the exit on the chain

Explorer: open the exit transaction (the signer page shows it) and find the `Exited` log from GROUP. It names your
key, the destination, the shares and every token amount paid.

```bash
cast logs --address $GROUP "Exited(address indexed member,address indexed to,uint256 shares,address[] assets,uint256[] amounts)" --from-block <block before the exit> --rpc-url $RPC
```

Then check that your share is gone (step 1 again shows fewer shares) and that each token arrived at the destination:

```bash
cast call <token> "balanceOf(address)(uint256)" <destination> --rpc-url $RPC
```

If a token could not be sent during the exit (for example its issuer paused it), the log `ExitOwed` names it. It is
set aside for the destination, and anyone can send it on later:

```bash
cast call $GROUP "owed(address,address)(uint256)" <token> <destination> --rpc-url $RPC
cast calldata "claimOwed(address,address)" <token> <destination>
```

The same exit, explained in plain words: paste its hash at `https://<signer site>/tx`.
