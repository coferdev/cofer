/** The /help text. /card is listed only when a card adapter runs (cards are off by default). */
export function helpText(opts: { cardsOn: boolean }): string {
  return [
    "/newpot open the group account",
    "/join ask to join (members vote)",
    "/deposit add USDG",
    "/buy TSLA 100 vote to buy with 100 USDG (add slip=0.5 for 0.5% slippage; default 1%)",
    "/sell TSLA 50% vote to sell (slip=0.5 works here too)",
    "/send 50 @bob vote to send",
    "/allowance @amy 50 week set a no-vote allowance",
    "/spend spend your allowance",
    ...(opts.cardsOn ? ["/card load a card from your allowance (optional)"] : []),
    "/exit take your exact share, any time",
    "/claim get a token set aside for you during an exit",
    "/me your share and allowance",
    "/pot what the group holds",
    "/plan 3 vote to prepay the optional group plan for 3 months",
    "/region XX declare your country (stock buys)",
  ].join("\n");
}

/** Reply to /card when no card adapter runs. */
export const CARDS_OFF_TEXT = "Cards are not available yet.";
